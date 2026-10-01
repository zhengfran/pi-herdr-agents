/**
 * The package-only current-host input contract for automatic routing: public
 * API feature detection, the exact TUI/interactive/idle gate, current-view
 * text/image/command screening, persisted-session and child predicates,
 * decision-only correlation, and confirmation of the void `pi.sendMessage`
 * through the public branch plus a bounded read-back of the real session
 * artifact written by the host's own SessionManager. Fixtures use only the
 * exported InputEvent fields; nothing here contacts a model or Herdr.
 */
import "./isolated-agent-dir.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	autoRoutingConfigDigest,
	parseAutoRoutingConfig,
	type LoadedAutoRoutingConfig,
} from "../pi-extension/subagents/auto-routing-config.ts";
import { AUTO_BYPASS_REASONS } from "../pi-extension/subagents/auto-routing-policy.ts";
import { AUTO_ROUTING_REQUEST_LIMITS } from "../pi-extension/subagents/auto-routing-candidates.ts";
import {
	AUTO_INPUT_BYPASS_REASONS,
	AUTO_PILOT_CONFIRM_TIMEOUT_MS,
	AUTO_RECEIPT_ENTRY_TYPE,
	AUTO_REQUEST_CUSTOM_TYPE,
	AUTO_REQUEST_RECORD_MAX_BYTES,
	AUTO_ROUTING_CHILD_ENV,
	AUTO_ROUTING_DISABLED_ENV,
	AUTO_STATUS_CUSTOM_TYPE,
	autoRequestView,
	autoStatusView,
	confirmAutoRequestRecorded,
	createAutoDecisionCorrelation,
	createAutoRoutingCoordinator,
	detectAutoInputSupport,
	escapeTerminalText,
	evaluateAutoRoutingInput,
	extractAutoRequestText,
	formatAutoRequestContent,
	formatAutoRoutingStatus,
	observeAutoRoutingSession,
	recordAutoRequest,
	screenAutoRoutingText,
	AUTO_MESSAGE_VIEW_LIMITS,
	recoverAutoRoutingWork,
	type AutoLaunchHandoff,
	type AutoLaunchOutcome,
} from "../pi-extension/subagents/auto-routing-input.ts";

const ROUTING_MODES = ["shadow", "pilot", "auto"] as const;
const HOST_MODES = ["tui", "rpc", "json", "print"] as const;
const SOURCES = ["interactive", "rpc", "extension"] as const;
const STREAMING = [undefined, "steer", "followUp"] as const;
const TASK = "Refactor the parser module and report the result.";
const IMAGE = {
	type: "image" as const,
	data: "aGVsbG8=",
	mimeType: "image/png",
};

function enabled(mode: (typeof ROUTING_MODES)[number]) {
	const config = parseAutoRoutingConfig(
		{
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
				roles: [
					{
						id: "worker",
						agent: "ar-worker",
						source: "global",
						definitionSha256: "0".repeat(64),
						labelRole: "build",
						intent: "report",
						purpose: "task",
						responsibility: "Reports on bounded repository questions.",
						deliverable: "A report.",
						excludes: "External publication.",
					},
				],
				candidates: [
					{
						id: "worker-pi",
						roleId: "worker",
						harness: "pi",
						model: { namespace: "pi", ref: "fake/exact-2" },
						effort: "medium",
						tier: "mid",
						family: "fixture-family",
						taskStrengths: "Reviewed offline strengths.",
						limitations: "Reviewed offline limitations.",
						capabilityEvidence: "Reviewed offline capability record.",
						preference: 1,
					},
				],
			},
		},
		"test.json",
	);
	if (config.mode === "off") throw new Error("expected an enabled config");
	return {
		status: "enabled" as const,
		source: "test.json",
		config,
		digest: autoRoutingConfigDigest(config),
	};
}

/** A session the host has written to disk: it holds a conversation. */
function persistedSession() {
	const root = mkdtempSync(join(tmpdir(), "ar-input-"));
	const manager = SessionManager.create(root, join(root, "sessions"));
	manager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Earlier question." }],
		timestamp: Date.now(),
	});
	// SAFETY: a complete stand-in assistant message; only its role and
	// presence matter to the host's deferred-file rule.
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Earlier answer." }],
		api: "fake",
		provider: "fake",
		model: "fake",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as any);
	assert.ok(existsSync(manager.getSessionFile()!), "the host wrote the file");
	return { root, manager };
}

/**
 * A current-API context over a real SessionManager that counts every call,
 * including any read of `ctx.signal`, which is undefined while idle.
 */
function harness(
	options: {
		mode?: string;
		idle?: boolean;
		pending?: boolean;
		herdr?: boolean;
		manager?: SessionManager;
	} = {},
) {
	const manager = options.manager ?? persistedSession().manager;
	const calls = {
		idle: 0,
		pending: 0,
		session: 0,
		classifier: 0,
		signal: 0,
		send: 0,
		herdr: 0,
	};
	const sessionManager = {
		getSessionId: () => (calls.session++, manager.getSessionId()),
		getSessionFile: () => (calls.session++, manager.getSessionFile()),
		getLeafId: () => (calls.session++, manager.getLeafId()),
		getLeafEntry: () => (calls.session++, manager.getLeafEntry()),
	};
	const ctx: any = {
		mode: options.mode ?? "tui",
		cwd: "/work",
		isIdle: () => (calls.idle++, options.idle ?? true),
		hasPendingMessages: () => (calls.pending++, options.pending ?? false),
		get signal() {
			calls.signal++;
			return undefined;
		},
		sessionManager,
		modelRegistry: {
			findOfType: () => {
				calls.classifier++;
				throw new Error("no classifier lookup during admission");
			},
			classify: () => {
				calls.classifier++;
				throw new Error("no classifier call during admission");
			},
		},
		ui: { confirm: async () => false },
	};
	const pi: any = {
		on() {},
		sendMessage: (message: any, sendOptions: any) => {
			calls.send++;
			// The host's idle non-triggering path appends synchronously.
			assert.equal(sendOptions?.triggerTurn, false);
			manager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		},
	};
	return {
		manager,
		calls,
		ctx,
		pi,
		gate: (
			event: any,
			extra: {
				mode?: (typeof ROUTING_MODES)[number];
				env?: NodeJS.ProcessEnv;
				busy?: boolean;
				config?: any;
			} = {},
		) =>
			evaluateAutoRoutingInput({
				config: extra.config ?? enabled(extra.mode ?? "auto"),
				event,
				ctx,
				pi,
				env: extra.env ?? {},
				busy: extra.busy ?? false,
				herdrAvailable: () => (calls.herdr++, options.herdr ?? true),
			}),
	};
}

/** An event with exactly the exported InputEvent fields. */
function inputEvent(
	text: string,
	source: (typeof SOURCES)[number] = "interactive",
	streamingBehavior?: "steer" | "followUp",
	images?: (typeof IMAGE)[],
) {
	return { type: "input" as const, text, images, source, streamingBehavior };
}

function reasonOf(result: ReturnType<ReturnType<typeof harness>["gate"]>) {
	return result.eligible ? "eligible" : result.reason;
}

describe("public API feature detection", () => {
	it("keeps every local reason in the shared receipt vocabulary", () => {
		const shared = new Set<string>(AUTO_BYPASS_REASONS);
		assert.deepEqual(
			AUTO_INPUT_BYPASS_REASONS.filter((reason) => !shared.has(reason)),
			[],
		);
		for (const reason of ["unsupported-public-api", "non-interactive-source"])
			assert.ok(shared.has(reason), reason);
		// Transformed input cannot be detected through the public API.
		assert.equal(
			new Set<string>(AUTO_INPUT_BYPASS_REASONS).has("transformed-input"),
			false,
		);
	});

	it("accepts the current public surface and never reads ctx.signal", () => {
		const { ctx, pi, calls } = harness();
		for (const mode of ROUTING_MODES)
			assert.deepEqual(detectAutoInputSupport(pi, ctx, mode), {
				supported: true,
			});
		assert.equal(calls.signal, 0);
		assert.equal(calls.idle + calls.session + calls.classifier, 0);
	});

	it("reports every missing method as unsupported-public-api", () => {
		const cases: [string, (ctx: any, pi: any) => void][] = [
			["pi.on", (_ctx, pi) => delete pi.on],
			["pi.sendMessage", (_ctx, pi) => delete pi.sendMessage],
			["ctx.mode", (ctx) => delete ctx.mode],
			["ctx.mode", (ctx) => (ctx.mode = "web")],
			["ctx.cwd", (ctx) => (ctx.cwd = "")],
			["ctx.isIdle", (ctx) => delete ctx.isIdle],
			["ctx.hasPendingMessages", (ctx) => delete ctx.hasPendingMessages],
			[
				"ctx.sessionManager.getLeafEntry",
				(ctx) => delete ctx.sessionManager.getLeafEntry,
			],
			[
				"ctx.sessionManager.getSessionFile",
				(ctx) => delete ctx.sessionManager.getSessionFile,
			],
			[
				"ctx.modelRegistry.classify",
				(ctx) => delete ctx.modelRegistry.classify,
			],
			[
				"ctx.modelRegistry.findOfType",
				(ctx) =>
					Object.defineProperty(ctx.modelRegistry, "findOfType", {
						get() {
							throw new Error("host getter failed");
						},
					}),
			],
		];
		for (const [missing, mutate] of cases) {
			const { ctx, pi, calls, gate } = harness();
			mutate(ctx, pi);
			const support = detectAutoInputSupport(pi, ctx, "auto");
			assert.ok(!support.supported, missing);
			assert.deepEqual(support.missing, [missing]);
			const result = gate(inputEvent(TASK));
			assert.equal(reasonOf(result), "unsupported-public-api", missing);
			assert.ok(!result.eligible && result.detail.includes(missing));
			assert.equal(calls.idle + calls.session + calls.herdr, 0, missing);
			assert.equal(calls.classifier + calls.send + calls.signal, 0, missing);
		}
	});

	it("requires dialog support only for pilot", () => {
		const { ctx, pi, gate } = harness();
		delete ctx.ui.confirm;
		assert.deepEqual(detectAutoInputSupport(pi, ctx, "pilot"), {
			supported: false,
			reason: "unsupported-public-api",
			missing: ["ctx.ui.confirm"],
		});
		assert.equal(
			reasonOf(gate(inputEvent(TASK), { mode: "pilot" })),
			"unsupported-public-api",
		);
		for (const mode of ["shadow", "auto"] as const)
			assert.equal(reasonOf(gate(inputEvent(TASK), { mode })), "eligible");
	});

	it("rejects an event that does not match the exported contract", () => {
		const { gate, calls } = harness();
		for (const event of [
			{ type: "input", text: TASK },
			{ type: "input", text: TASK, source: "editor" },
			{
				type: "input",
				text: TASK,
				source: "interactive",
				streamingBehavior: "next",
			},
			{ type: "input", text: TASK, source: "interactive", images: IMAGE },
			{ type: "input", source: "interactive" },
		])
			assert.equal(reasonOf(gate(event)), "unsupported-public-api");
		assert.equal(calls.idle + calls.session + calls.herdr, 0);
	});

	it("captures event fields once and rejects failing or changing reads without side effects", () => {
		const fields: [string, any, any][] = [
			["text", TASK, "/subagent scout inspect"],
			["source", "interactive", "rpc"],
			["streamingBehavior", undefined, "steer"],
			["images", [], [IMAGE]],
		];
		for (const [field, first, then] of fields) {
			let reads = 0;
			const getters: [string, () => any][] = [
				[
					"throwing",
					() => {
						throw new Error("host getter failed");
					},
				],
				["changing", () => (reads++ === 0 ? first : then)],
			];
			for (const [kind, get] of getters) {
				const label = `${kind} ${field}`;
				const { gate, calls } = harness();
				const event = inputEvent(TASK);
				Object.defineProperty(event, field, { get, enumerable: true });
				let result: ReturnType<typeof gate> | undefined;
				assert.doesNotThrow(() => {
					result = gate(event);
				}, label);
				assert.equal(reasonOf(result!), "unsupported-public-api", label);
				assert.equal(calls.idle + calls.pending + calls.session, 0, label);
				assert.equal(calls.herdr + calls.classifier + calls.send, 0, label);
				assert.equal(calls.signal, 0, label);
			}
			assert.ok(reads <= 1, `${field} was read at most once`);
		}
		const throwingTrap = {
			getOwnPropertyDescriptor(): PropertyDescriptor {
				throw new Error("host trap failed");
			},
		};
		for (const [label, event] of [
			["event trap", new Proxy(inputEvent(TASK), throwingTrap)],
			[
				"image count trap",
				inputEvent(TASK, "interactive", undefined, new Proxy([], throwingTrap)),
			],
			["inherited fields", Object.create(inputEvent(TASK))],
		] as const) {
			const { gate, calls } = harness();
			assert.equal(reasonOf(gate(event)), "unsupported-public-api", label);
			assert.equal(calls.idle + calls.session + calls.herdr + calls.send, 0);
		}
	});
});

describe("hostile and inherited event fields", () => {
	/** Own text and source over a prototype supplying other fields. */
	function withPrototype(proto: any, text: any = TASK) {
		const event = Object.create(proto);
		event.type = "input";
		event.text = text;
		event.source = "interactive";
		return event;
	}

	function assertRejectedQuietly(event: any, label: string) {
		const { gate, calls } = harness();
		let result: ReturnType<typeof gate> | undefined;
		assert.doesNotThrow(() => {
			result = gate(event);
		}, label);
		assert.equal(reasonOf(result!), "unsupported-public-api", label);
		assert.equal(calls.idle + calls.pending + calls.session, 0, label);
		assert.equal(calls.herdr + calls.classifier + calls.send, 0, label);
		assert.equal(calls.signal, 0, label);
	}

	it("rejects inherited optional fields instead of reading them as absent", () => {
		assertRejectedQuietly(
			withPrototype({ images: [IMAGE] }),
			"inherited images",
		);
		assertRejectedQuietly(
			withPrototype({ streamingBehavior: "steer" }),
			"inherited streaming",
		);
	});

	it("never invokes an inherited optional accessor", () => {
		for (const field of ["images", "streamingBehavior"]) {
			let reads = 0;
			const proto = {};
			Object.defineProperty(proto, field, {
				get() {
					reads++;
					return undefined;
				},
			});
			assertRejectedQuietly(withPrototype(proto), `inherited ${field} getter`);
			assert.equal(reads, 0, `${field} accessor was not invoked`);
		}
	});

	it("admits optional fields absent from the whole prototype chain", () => {
		for (const [label, event] of [
			["plain", { type: "input", text: TASK, source: "interactive" }],
			["null prototype", withPrototype(null)],
			["empty prototype", withPrototype({})],
		] as const) {
			const { gate, calls } = harness();
			const result = gate(event);
			assert.ok(result.eligible, label);
			assert.equal(result.request, TASK, label);
			assert.equal(calls.classifier + calls.send + calls.signal, 0, label);
		}
	});

	it("requires primitive text without consulting Symbol.toStringTag", () => {
		let tagReads = 0;
		const throwingTag = {};
		Object.defineProperty(throwingTag, Symbol.toStringTag, {
			get() {
				tagReads++;
				throw new Error("hostile toStringTag");
			},
		});
		const countingTag = {
			get [Symbol.toStringTag]() {
				tagReads++;
				return "String";
			},
		};
		for (const [label, text] of [
			["boxed", new String(TASK)],
			["spoofed tag", { [Symbol.toStringTag]: "String" }],
			["counting tag", countingTag],
			["throwing tag", throwingTag],
		] as const)
			assertRejectedQuietly(
				{ type: "input", text, source: "interactive" },
				`${label} text`,
			);
		assert.equal(tagReads, 0, "Symbol.toStringTag was never read");
	});

	it("contains a revoked image proxy", () => {
		const { proxy, revoke } = Proxy.revocable([IMAGE], {});
		revoke();
		assertRejectedQuietly(
			inputEvent(TASK, "interactive", undefined, proxy),
			"revoked images",
		);
	});
});

describe("mode, source, and streaming gate", () => {
	it("admits only TUI + interactive + undefined streaming, identically for every routing mode", () => {
		for (const routing of ROUTING_MODES)
			for (const hostMode of HOST_MODES)
				for (const source of SOURCES)
					for (const streaming of STREAMING) {
						const { gate, calls } = harness({ mode: hostMode });
						const result = gate(inputEvent(TASK, source, streaming), {
							mode: routing,
						});
						const label = `${routing}/${hostMode}/${source}/${streaming}`;
						const admitted =
							hostMode === "tui" &&
							source === "interactive" &&
							streaming === undefined;
						assert.equal(result.eligible, admitted, label);
						if (!admitted) {
							assert.equal(
								reasonOf(result),
								hostMode !== "tui"
									? "unsupported-session-mode"
									: source !== "interactive"
										? "non-interactive-source"
										: "not-fresh-prompt",
								label,
							);
							// Rejected before any context method, session file, or Herdr probe.
							assert.equal(
								calls.idle + calls.pending + calls.session + calls.herdr,
								0,
								label,
							);
						}
						assert.equal(calls.classifier + calls.send, 0, label);
						assert.equal(calls.signal, 0, label);
					}
	});

	it("bypasses steer and follow-up even in an unexpectedly idle context", () => {
		for (const streaming of ["steer", "followUp"] as const) {
			const { gate } = harness({ idle: true });
			assert.equal(
				reasonOf(gate(inputEvent(TASK, "interactive", streaming))),
				"not-fresh-prompt",
			);
		}
	});

	it("captures the exact handler-visible text and the persisted session", () => {
		const { gate, manager } = harness();
		const text = "  Explain the lexer\ttoken flow.\n";
		const result = gate(inputEvent(text));
		assert.ok(result.eligible);
		assert.equal(result.request, text);
		assert.equal(result.mode, "auto");
		assert.equal(result.session.sessionId, manager.getSessionId());
		assert.equal(result.session.branchAnchor, manager.getLeafId());
		assert.ok(Object.isFrozen(result) && Object.isFrozen(result.session));
	});
});

describe("configuration, child, busy, and idle predicates", () => {
	it("bypasses off and invalid configuration before anything else", () => {
		const { gate, calls } = harness();
		assert.equal(
			reasonOf(
				gate(inputEvent(TASK), {
					config: {
						status: "off",
						source: "x",
						origin: "missing-file",
						config: { version: 1, mode: "off" },
						digest: "d",
					},
				}),
			),
			"routing-off",
		);
		assert.equal(
			reasonOf(
				gate(inputEvent(TASK), {
					config: { status: "invalid", source: "x", diagnostic: "bad" },
				}),
			),
			"config-invalid",
		);
		assert.equal(calls.idle + calls.session + calls.herdr + calls.signal, 0);
	});

	it("rejects every child identity and the package recursion guard", () => {
		for (const name of [...AUTO_ROUTING_CHILD_ENV, AUTO_ROUTING_DISABLED_ENV]) {
			const { gate, calls } = harness();
			assert.equal(
				reasonOf(gate(inputEvent(TASK), { env: { [name]: "1" } })),
				"child-session",
				name,
			);
			assert.equal(calls.idle + calls.session, 0);
		}
		// An empty value is not an identity; prompt wording is never one.
		const { gate } = harness();
		assert.equal(
			reasonOf(
				gate(inputEvent("As a child agent, summarize the parser."), {
					env: { PI_SUBAGENT_ID: "" },
				}),
			),
			"eligible",
		);
	});

	it("requires an idle parent with nothing queued and no outstanding decision", () => {
		assert.equal(
			reasonOf(harness().gate(inputEvent(TASK), { busy: true })),
			"auto-busy",
		);
		assert.equal(
			reasonOf(harness({ idle: false }).gate(inputEvent(TASK))),
			"parent-busy",
		);
		assert.equal(
			reasonOf(harness({ pending: true }).gate(inputEvent(TASK))),
			"parent-busy",
		);
		const { gate, ctx } = harness();
		ctx.isIdle = () => {
			throw new Error("host failure");
		};
		assert.equal(reasonOf(gate(inputEvent(TASK))), "unsupported-public-api");
	});
});

describe("current text and image predicates", () => {
	it("rejects any current image, including mixed text and image", () => {
		const { gate } = harness();
		assert.equal(
			reasonOf(gate(inputEvent(TASK, "interactive", undefined, []))),
			"eligible",
		);
		assert.equal(
			reasonOf(gate(inputEvent(TASK, "interactive", undefined, [IMAGE]))),
			"image-input",
		);
		assert.equal(
			reasonOf(gate(inputEvent("", "interactive", undefined, [IMAGE]))),
			"image-input",
		);
	});

	it("screens blank, command, oversize, opt-out, control, and binary text", () => {
		const cases: [string, string][] = [
			["", "blank-prompt"],
			[" \n\t ", "blank-prompt"],
			["/subagent scout inspect", "command-input"],
			["  \n/skill:orchestrate", "command-input"],
			["!ls -la", "command-input"],
			["\t!git status", "command-input"],
			[
				"x".repeat(AUTO_ROUTING_REQUEST_LIMITS.maxPromptBytes + 1),
				"prompt-too-large",
			],
			[
				"é".repeat(AUTO_ROUTING_REQUEST_LIMITS.maxPromptBytes / 2 + 1),
				"prompt-too-large",
			],
			["Summarize the parser. [NO-AUTO-ROUTE]", "user-opt-out"],
			["Summarize\u0000 the parser.", "egress-screened"],
			["Summarize\u001b[31m the parser.", "egress-screened"],
			["Summarize \ud800 the parser.", "egress-screened"],
			["Summarize � the parser.", "egress-screened"],
		];
		for (const [text, reason] of cases) {
			assert.equal(
				reasonOf(harness().gate(inputEvent(text))),
				reason,
				JSON.stringify(text.slice(0, 40)),
			);
		}
		// Exactly the byte limit, a path, and a mid-text slash are ordinary.
		for (const text of [
			"é".repeat(AUTO_ROUTING_REQUEST_LIMITS.maxPromptBytes / 2),
			"Explain src/parser.ts and why a/b fails.",
			"What does `!important` do in this CSS?",
			"Line one\r\nLine two\twith tab",
		])
			assert.equal(screenAutoRoutingText(text).ok, true, text.slice(0, 40));
	});

	it("screens recognizable credentials without echoing them", () => {
		const secrets = [
			"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----",
			"-----BEGIN RSA PRIVATE KEY-----",
			"use AKIAIOSFODNN7EXAMPLE for the bucket",
			`token ghp_${"a".repeat(36)} please`,
			`sk-ant-${"b".repeat(40)}`,
			"export TYPESAFE_API_KEY=abcd1234efgh5678",
			'config: { "client_secret": "s3cr3tvalue99" }',
			"password = hunter2hunter2",
			"Authorization: Bearer abcdef0123456789",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijkl",
		];
		for (const secret of secrets) {
			const result = harness().gate(inputEvent(`Please debug this: ${secret}`));
			assert.equal(reasonOf(result), "egress-screened", secret.slice(0, 30));
			assert.ok(!result.eligible && !result.detail.includes(secret.slice(-8)));
		}
		for (const benign of [
			"Fix the password reset flow in the login page.",
			"Why does the token count differ from the tokenizer output?",
			"Rotate the API key documentation section.",
		])
			assert.equal(screenAutoRoutingText(benign).ok, true, benign);
	});
});

describe("persisted session predicate", () => {
	it("bypasses a new session whose file the host has not created yet", () => {
		const root = mkdtempSync(join(tmpdir(), "ar-input-new-"));
		const manager = SessionManager.create(root, join(root, "sessions"));
		const file = manager.getSessionFile();
		assert.ok(file && !existsSync(file), "the host defers the new file");
		const { gate, calls } = harness({ manager });
		assert.equal(reasonOf(gate(inputEvent(TASK))), "no-session-file");
		assert.equal(calls.herdr, 0);
		// A non-triggering custom message cannot flush it either.
		manager.appendCustomMessageEntry("probe", "x", false, undefined);
		assert.equal(existsSync(file), false);
		assert.equal(
			observeAutoRoutingSession({ sessionManager: manager }).ok,
			false,
		);
	});

	it("bypasses without a session file, identity, or matching header", () => {
		const cases: [string, (sm: any, manager: SessionManager) => void][] = [
			["no file", (sm) => (sm.getSessionFile = () => undefined)],
			["no id", (sm) => (sm.getSessionId = () => "")],
			["other session", (sm) => (sm.getSessionId = () => "other-session")],
			[
				"throws",
				(sm) =>
					(sm.getLeafId = () => {
						throw new Error("x");
					}),
			],
		];
		for (const [label, mutate] of cases) {
			const { gate, ctx, manager, calls } = harness();
			mutate(ctx.sessionManager, manager);
			assert.equal(reasonOf(gate(inputEvent(TASK))), "no-session-file", label);
			assert.equal(calls.herdr, 0, label);
		}
	});

	it("probes Herdr last and bypasses when it is unavailable", () => {
		const { gate, calls } = harness({ herdr: false });
		assert.equal(reasonOf(gate(inputEvent(TASK))), "herdr-unavailable");
		assert.equal(calls.herdr, 1);
		const throwing = harness();
		const result = evaluateAutoRoutingInput({
			config: enabled("auto"),
			event: inputEvent(TASK),
			ctx: throwing.ctx,
			pi: throwing.pi,
			env: {},
			busy: false,
			herdrAvailable: () => {
				throw new Error("herdr probe failed");
			},
		});
		assert.equal(reasonOf(result), "herdr-unavailable");
	});
});

describe("earlier transforms: only the current view is observable", () => {
	type Handler = (event: any) => any;

	/** The installed runner's documented chain: transforms fold, handled stops. */
	async function emitInput(
		handlers: Handler[],
		text: string,
		images: any[] | undefined,
	) {
		let currentText = text;
		let currentImages = images;
		for (const handler of handlers) {
			const event = {
				type: "input",
				text: currentText,
				images: currentImages,
				source: "interactive",
				streamingBehavior: undefined,
			};
			const result = await handler(event);
			if (result?.action === "handled") return result;
			if (result?.action === "transform") {
				currentText = result.text;
				currentImages = result.images ?? currentImages;
			}
		}
		return { action: "continue" };
	}

	function routed() {
		const seen: any[] = [];
		const { gate } = harness();
		const handler: Handler = (event) => {
			seen.push({ keys: Object.keys(event).sort(), result: gate(event) });
			return { action: "continue" };
		};
		return { seen, handler };
	}

	it("admits a view whose image, command syntax, and opt-out were removed upstream", async () => {
		const { seen, handler } = routed();
		const earlier: Handler = (event) => ({
			action: "transform",
			text: event.text
				.replace(/^\/explain\s*/, "Explain ")
				.replace(" [no-auto-route]", ""),
			images: [],
		});
		await emitInput(
			[earlier, handler],
			"/explain the parser module [no-auto-route]",
			[IMAGE],
		);
		const [{ keys, result }] = seen;
		// Only the exported fields exist; no original text or image evidence.
		assert.deepEqual(keys, [
			"images",
			"source",
			"streamingBehavior",
			"text",
			"type",
		]);
		assert.ok(result.eligible);
		assert.equal(result.request, "Explain the parser module");
	});

	it("screens file content an earlier handler expanded into the text", async () => {
		const { seen, handler } = routed();
		const expander: Handler = (event) => ({
			action: "transform",
			text: `${event.text}\n<file name=".env">API_KEY=abcd1234efgh5678</file>`,
		});
		await emitInput([expander, handler], "Review my config", undefined);
		assert.equal(reasonOf(seen[0].result), "egress-screened");
	});

	it("never sees input an earlier handler consumed", async () => {
		const { seen, handler } = routed();
		await emitInput([() => ({ action: "handled" }), handler], TASK, undefined);
		assert.equal(seen.length, 0);
	});
});

describe("decision-only correlation", () => {
	it("mints a random package decision ID bound to a session generation", () => {
		const { gate } = harness();
		const result = gate(inputEvent(TASK));
		assert.ok(result.eligible);
		const ids = new Set<string>();
		for (let index = 0; index < 500; index++) {
			const correlation = createAutoDecisionCorrelation(result.session, 3);
			assert.match(correlation.decisionId, /^ad-[0-9a-f-]{36}$/);
			assert.equal(correlation.parentSessionId, result.session.sessionId);
			assert.equal(correlation.sessionGeneration, 3);
			assert.deepEqual(Object.keys(correlation).sort(), [
				"decisionId",
				"parentSessionId",
				"sessionGeneration",
			]);
			ids.add(correlation.decisionId);
		}
		assert.equal(ids.size, 500, "identical text is a new attempt each time");
		for (const generation of [-1, 1.5, Number.NaN])
			assert.throws(
				() => createAutoDecisionCorrelation(result.session, generation),
				TypeError,
			);
	});
});

describe("request persistence confirmation for void sendMessage", () => {
	function admitted() {
		const h = harness();
		const result = h.gate(inputEvent(TASK));
		assert.ok(result.eligible);
		const { decisionId } = createAutoDecisionCorrelation(result.session, 1);
		const record = {
			customType: "jev_auto_request",
			content: `Handler-visible request awaiting delegation:\n${JSON.stringify(result.request)}`,
			display: true,
			details: {
				version: 1,
				decisionId,
				source: "interactive",
				state: "accepted",
			},
		};
		return { ...h, session: result.session, decisionId, record };
	}

	it("confirms the exact entry on the branch and in the real session artifact", () => {
		const { pi, ctx, manager, session, decisionId, record, calls } = admitted();
		const confirmation = recordAutoRequest(
			pi,
			ctx,
			session,
			decisionId,
			record,
		);
		assert.ok(confirmation.ok, JSON.stringify(confirmation));
		assert.equal(calls.send, 1);
		assert.equal(confirmation.entryId, manager.getLeafId());
		assert.equal(confirmation.offset, session.size);

		// Independently inspect the artifact the host wrote.
		const file = manager.getSessionFile()!;
		const bytes = readFileSync(file);
		assert.equal(bytes.length, session.size + confirmation.bytes);
		const line = JSON.parse(bytes.subarray(session.size).toString("utf8"));
		assert.equal(line.type, "custom_message");
		assert.equal(line.id, confirmation.entryId);
		assert.equal(line.parentId, session.branchAnchor);
		assert.equal(line.content, record.content);
		assert.deepEqual(line.details, record.details);
		// A reload sees it on the branch, so export and model context do too.
		const reopened = SessionManager.open(file, join(file, "..")).getBranch();
		assert.equal(reopened.at(-1)?.id, confirmation.entryId);
	});

	it("sends nothing when not idle, drifted, mismatched, or oversized", () => {
		const cases: [string, (h: ReturnType<typeof admitted>) => any][] = [
			["busy", (h) => ((h.ctx.isIdle = () => false), h.record)],
			["queued", (h) => ((h.ctx.hasPendingMessages = () => true), h.record)],
			[
				"branch moved",
				(h) => (
					h.manager.appendCustomMessageEntry("other", "x", false, undefined),
					h.record
				),
			],
			[
				"other decision",
				(h) => ({
					...h.record,
					details: { ...h.record.details, decisionId: "ad-other" },
				}),
			],
			[
				"oversized",
				(h) => ({
					...h.record,
					content: "x".repeat(AUTO_REQUEST_RECORD_MAX_BYTES),
				}),
			],
		];
		for (const [label, prepare] of cases) {
			const h = admitted();
			const record = prepare(h);
			const result = recordAutoRequest(
				h.pi,
				h.ctx,
				h.session,
				h.decisionId,
				record,
			);
			assert.ok(!result.ok, label);
			assert.equal(result.sendAttempted, false, label);
			assert.equal(h.calls.send, 0, label);
		}
	});

	it("treats deferred, failed, altered, accompanied, or replaced writes as unconfirmed", () => {
		const cases: [string, (h: ReturnType<typeof admitted>) => void][] = [
			[
				"deferred like a streaming append",
				(h) => (h.pi.sendMessage = () => {}),
			],
			[
				"send threw",
				(h) =>
					(h.pi.sendMessage = () => {
						throw new Error("send failed");
					}),
			],
			[
				"host altered content",
				(h) =>
					(h.pi.sendMessage = (message: any) =>
						h.manager.appendCustomMessageEntry(
							message.customType,
							[{ type: "text", text: message.content }],
							message.display,
							message.details,
						)),
			],
			[
				"another entry followed",
				(h) => {
					const send = h.pi.sendMessage;
					h.pi.sendMessage = (message: any, options: any) => {
						send(message, options);
						h.manager.appendCustomMessageEntry("other", "x", false, undefined);
					};
				},
			],
			[
				"another entry preceded",
				(h) => {
					const send = h.pi.sendMessage;
					h.pi.sendMessage = (message: any, options: any) => {
						h.manager.appendCustomMessageEntry("other", "x", false, undefined);
						send(message, options);
					};
				},
			],
			[
				"extra bytes on disk",
				(h) => {
					const send = h.pi.sendMessage;
					h.pi.sendMessage = (message: any, options: any) => {
						send(message, options);
						appendFileSync(h.manager.getSessionFile()!, "{}\n");
					};
				},
			],
			[
				"file replaced",
				(h) => {
					const send = h.pi.sendMessage;
					h.pi.sendMessage = (message: any, options: any) => {
						const file = h.manager.getSessionFile()!;
						copyFileSync(file, `${file}.copy`);
						renameSync(`${file}.copy`, file);
						send(message, options);
					};
				},
			],
			[
				"session switched",
				(h) => {
					const other = persistedSession().manager;
					h.pi.sendMessage = () => {
						h.ctx.sessionManager.getSessionId = () => other.getSessionId();
						h.ctx.sessionManager.getSessionFile = () => other.getSessionFile();
					};
				},
			],
		];
		for (const [label, prepare] of cases) {
			const h = admitted();
			prepare(h);
			const result = recordAutoRequest(
				h.pi,
				h.ctx,
				h.session,
				h.decisionId,
				h.record,
			);
			assert.ok(!result.ok, label);
			assert.equal(result.reason, "request-record-failed", label);
			assert.equal(result.sendAttempted, true, label);
			assert.ok(!result.detail.includes(TASK), label);
		}
	});

	it("sends nothing after a disk-only append or same-inode truncation", () => {
		const cases: [string, (file: string) => void][] = [
			["disk-only append", (file) => appendFileSync(file, "{}\n")],
			[
				"same-inode truncation",
				(file) => {
					const bytes = readFileSync(file);
					truncateSync(file, bytes.lastIndexOf(10, bytes.length - 2) + 1);
				},
			],
		];
		for (const [label, mutate] of cases) {
			const h = admitted();
			const file = h.manager.getSessionFile()!;
			const inode = statSync(file).ino;
			const leaf = h.manager.getLeafId();
			mutate(file);
			assert.equal(statSync(file).ino, inode, label);
			assert.equal(h.manager.getLeafId(), leaf, label);
			// Still a valid session on the same branch: only the size drifted.
			assert.ok(observeAutoRoutingSession(h.ctx).ok, label);
			const result = recordAutoRequest(
				h.pi,
				h.ctx,
				h.session,
				h.decisionId,
				h.record,
			);
			assert.ok(!result.ok, label);
			assert.equal(result.sendAttempted, false, label);
			assert.equal(h.calls.send, 0, label);
		}
	});

	it("never sends or confirms after an entry that lacks its newline", () => {
		const tears: [string, (file: string) => void][] = [
			[
				"unterminated valid last entry",
				(file) => truncateSync(file, statSync(file).size - 1),
			],
			[
				"torn line",
				(file) => appendFileSync(file, '{"type":"custom_message","id":'),
			],
		];
		for (const [label, tear] of tears) {
			// Before sending: no observation admits such a file.
			const before = admitted();
			const beforeFile = before.manager.getSessionFile()!;
			tear(beforeFile);
			assert.equal(
				reasonOf(before.gate(inputEvent(TASK))),
				"no-session-file",
				label,
			);
			const current = { ...before.session, size: statSync(beforeFile).size };
			const refused = recordAutoRequest(
				before.pi,
				before.ctx,
				current,
				before.decisionId,
				before.record,
			);
			assert.ok(!refused.ok, label);
			assert.equal(refused.sendAttempted, false, label);
			assert.equal(before.calls.send, 0, label);

			// During confirmation: the appended bytes alone parse as the entry,
			// but they continue the previous line, so a reload would drop it.
			const h = admitted();
			const file = h.manager.getSessionFile()!;
			tear(file);
			const baseline = { ...h.session, size: statSync(file).size };
			h.pi.sendMessage(h.record, { triggerTurn: false });
			const appended = readFileSync(file).subarray(baseline.size);
			assert.equal(
				JSON.parse(appended.toString("utf8")).id,
				h.manager.getLeafId(),
			);
			const result = confirmAutoRequestRecorded(h.ctx, baseline, h.record);
			assert.ok(!result.ok, label);
			assert.equal(result.sendAttempted, true, label);
			assert.match(result.detail, /line/, label);
			const reopened = SessionManager.open(file, join(file, "..")).getBranch();
			assert.notEqual(reopened.at(-1)?.id, h.manager.getLeafId(), label);
		}
	});

	it("does not confirm against a stale baseline or an unrelated leaf", () => {
		const h = admitted();
		assert.ok(!confirmAutoRequestRecorded(h.ctx, h.session, h.record).ok);
		h.pi.sendMessage(h.record, { triggerTurn: false });
		const stale = { ...h.session, size: 0 };
		assert.ok(!confirmAutoRequestRecorded(h.ctx, stale, h.record).ok);
		assert.ok(confirmAutoRequestRecorded(h.ctx, h.session, h.record).ok);
	});
});

describe("special files at the session path", {
	skip: process.platform === "win32" && "FIFOs are POSIX-only",
}, () => {
	const MODULE = new URL(
		"../pi-extension/subagents/auto-routing-input.ts",
		import.meta.url,
	).href;
	/** Runs in a child so a blocking open is killed instead of hanging the suite. */
	const CHILD = `
const [moduleUrl, kind, dir] = process.argv.slice(1);
const { appendFileSync, renameSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const input = await import(moduleUrl);
const fifo = join(dir, "fifo");
const file = join(dir, "session.jsonl");
let leaf = null;
const sessionManager = {
	getSessionId: () => "fifo-session",
	getSessionFile: () => (kind === "observe" ? fifo : file),
	getLeafId: () => (leaf === null ? null : leaf.id),
	getLeafEntry: () => {
		renameSync(fifo, file);
		return leaf;
	},
};
let result;
if (kind === "observe") result = input.observeAutoRoutingSession({ sessionManager });
else {
	writeFileSync(file, JSON.stringify({ type: "session", id: "fifo-session" }) + "\\n");
	const baseline = input.observeAutoRoutingSession({ sessionManager });
	if (!baseline.ok) throw new Error("baseline was not observed");
	const record = { customType: "probe", content: "x", display: false, details: { decisionId: "ad-fifo" } };
	leaf = { type: "custom_message", id: "e1", parentId: null, timestamp: "t", ...record };
	appendFileSync(file, JSON.stringify(leaf) + "\\n");
	result = input.confirmAutoRequestRecorded({ sessionManager }, baseline.session, record);
}
process.stdout.write(JSON.stringify(result));
`;

	function runBounded(kind: "observe" | "confirm") {
		const dir = mkdtempSync(join(tmpdir(), "ar-input-fifo-"));
		execFileSync("mkfifo", [join(dir, "fifo")]);
		const child = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings",
				"--input-type=module",
				"-e",
				CHILD,
				MODULE,
				kind,
				dir,
			],
			{ encoding: "utf8", timeout: 10_000 },
		);
		assert.equal(child.signal, null, "the session read did not block");
		assert.equal(child.status, 0, child.stderr);
		return JSON.parse(child.stdout);
	}

	it("bypasses a FIFO at the session path without waiting for a writer", () => {
		const result = runBounded("observe");
		assert.equal(result.ok, false);
		assert.equal(result.reason, "no-session-file");
	});

	it("fails confirmation promptly when a FIFO replaces the session file", () => {
		const result = runBounded("confirm");
		assert.equal(result.ok, false);
		assert.equal(result.sendAttempted, true);
		assert.equal(
			result.detail,
			"The session file was replaced while recording.",
		);
	});
});

// ── Input coordinator (T07) ──────────────────────────────────────────────
//
// The coordinator runs against a real SessionManager artifact, the
// extension's own launch authority and role discovery, the real two-batch
// questions and deterministic policy, and an injected fake transport and
// launch handoff. Nothing contacts Jev, a model, or Herdr.

const flow = await import("./native-flow-harness.ts");
const { autoRoleDefinitionSha256 } = await import(
	"../pi-extension/subagents/auto-routing-candidates.ts"
);
const { validateJevEvidence } = await import(
	"../pi-extension/subagents/auto-routing-policy.ts"
);
const { JEV_CONSEQUENCE_LEVELS, JEV_REASONING_LEVELS } = await import(
	"../pi-extension/subagents/jev-questions.ts"
);
const { createJevDeadline, createJevTransport, JEV_CLASSIFIER_ENDPOINT } =
	await import("../pi-extension/subagents/jev-client.ts");
const { TYPESAFE_CLASSIFIER_MODELS } = await import(
	"@earendil-works/pi-ai/providers/typesafe.models"
);
const extensionModule = await import("../pi-extension/subagents/index.ts");

const ROUTED_ROLE = "ai-reporter";
flow.writeRole(ROUTED_ROLE, [
	"auto-exit: true",
	"tools: read, bash",
	"spawning: false",
]);

function routedRole() {
	const role = flow.testApi
		.discoverAgentCatalog(flow.api)
		.agents.find((candidate) => candidate.name === ROUTED_ROLE);
	assert.ok(role, "the routed role is discovered");
	return {
		id: "reporter",
		agent: ROUTED_ROLE,
		source: role.source,
		definitionSha256: autoRoleDefinitionSha256(role),
		labelRole: "build",
		intent: "report",
		purpose: "task",
		responsibility: "Reports on bounded repository questions.",
		deliverable: "A report.",
		excludes: "External publication.",
	};
}

function routingConfig(
	mode: (typeof ROUTING_MODES)[number],
	failurePolicy: "parent" | "hold" = "parent",
	effort = "high",
	native?: { harness: "claude" | "kiro"; id: string },
) {
	const config = parseAutoRoutingConfig(
		{
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
				roles: [routedRole()],
				candidates: [
					{
						id: native ? `reporter-${native.harness}` : "reporter-pi",
						roleId: "reporter",
						harness: native?.harness ?? "pi",
						model: native
							? { namespace: native.harness, id: native.id }
							: { namespace: "pi", ref: "fake/exact-2" },
						effort,
						tier: "mid",
						family: "fixture-family",
						taskStrengths: "Reviewed offline strengths.",
						limitations: "Reviewed offline limitations.",
						capabilityEvidence: "Reviewed offline capability record.",
						preference: 1,
					},
				],
			},
		},
		"test.json",
	);
	if (config.mode === "off") throw new Error("expected an enabled config");
	return {
		status: "enabled" as const,
		source: "test.json",
		config,
		digest: autoRoutingConfigDigest(config),
	};
}

/** A Pi registry the launch authority accepts; its classifier seam is fenced. */
function piRegistry(counts: { classifier: number }) {
	const models = ["parent", "exact-2"].map((id) => ({
		provider: "fake",
		id,
		api: "openai-completions",
		reasoning: true,
		input: ["text"],
	}));
	const exact = (provider: string, id: string) =>
		models.find((model) => model.provider === provider && model.id === id);
	return {
		find: exact,
		getAvailable: () => models,
		hasConfiguredAuth: () => true,
		findOfType: () => {
			counts.classifier++;
			throw new Error("the coordinator never reads the registry directly");
		},
		classify: () => {
			counts.classifier++;
			throw new Error("the coordinator never classifies directly");
		},
	};
}

function choiceAnswer(options: readonly string[], winner: string) {
	// The winner holds 0.9; the rest goes to `none`, or to the first option
	// when `none` wins, so the distribution is complete.
	const rest = winner === "none" ? options[0] : "none";
	return {
		type: "choice",
		choice: winner,
		probabilities: Object.fromEntries(
			options.map((option) => [
				option,
				option === winner ? 0.9 : option === rest ? 0.1 : 0,
			]),
		),
		confidence: 0.95,
	};
}

function scoreAnswer(levels: readonly string[], distribution: number[]) {
	return {
		type: "score",
		score: distribution.reduce((sum, p, level) => sum + p * level, 0),
		probabilities: Object.fromEntries(
			distribution.map((p, level) => [String(level), p]),
		),
		legend: Object.fromEntries(levels.map((level, i) => [String(i), level])),
		confidence: 0.95,
	};
}

/** A wire body selecting the first role/runtime/model; `none` abstains. */
function wireFor(batch: any, abstain = false) {
	const answers: any = {};
	for (const question of batch.expected) {
		if (question.type === "choice")
			answers[question.id] = choiceAnswer(
				question.options,
				abstain ? "none" : question.options[0],
			);
		else if (question.id === "reasoning")
			answers[question.id] = scoreAnswer(
				JEV_REASONING_LEVELS,
				[0.05, 0.9, 0.05, 0],
			);
		else if (question.id === "consequence")
			answers[question.id] = scoreAnswer(
				JEV_CONSEQUENCE_LEVELS,
				[0.95, 0.05, 0, 0],
			);
		else
			answers[question.id] = {
				type: "noul",
				noul: question.id.startsWith("role_fit_") ? 0.95 : 0.05,
			};
	}
	return {
		model: "jev-1.13.0",
		answers,
		usage: { input_tokens: 1200, output_tokens: 40 },
	};
}

/** Pi's normalized classifier result for a wire body. */
function normalized(batch: any, wire: any) {
	const answers: any = {};
	for (const question of batch.expected) {
		const answer = wire.answers[question.id];
		answers[question.id] =
			question.type === "choice"
				? { ...answer, probabilities: { ...answer.probabilities } }
				: question.type === "score"
					? {
							type: "score",
							score: answer.score,
							confidence: answer.confidence,
						}
					: { type: "bool", probability: answer.noul };
	}
	return {
		api: "typesafe-system-one",
		provider: "typesafe",
		model: "jev-1.13.0",
		answers,
		usage: {
			input: 1200,
			output: 40,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1240,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function evidenceResult(batch: any, abstain = false) {
	const wire = wireFor(batch, abstain);
	const validation = validateJevEvidence(batch, {
		wire,
		result: normalized(batch, wire),
	});
	if (!validation.ok) throw new Error(validation.detail);
	return { status: "ok" as const, evidence: validation.evidence };
}

type Respond = (batch: any, index: number) => any;

/** An injected transport: real deadline, scripted results, recorded calls. */
function fakeTransport(
	respond: Respond = (batch) => evidenceResult(batch),
	clockNow: () => number = () => 0,
) {
	const calls: Array<{
		batch: any;
		deadline: any;
		signals: any[];
		authorize?: () => boolean;
	}> = [];
	const deadlines: any[] = [];
	return {
		calls,
		deadlines,
		transport: {
			createDeadline(totalMs: number) {
				const deadline = createJevDeadline(totalMs, clockNow);
				deadlines.push(deadline);
				return deadline;
			},
			async classify(request: any) {
				calls.push({
					batch: request.batch,
					deadline: request.deadline,
					signals: [...(request.signals ?? [])],
					authorize: request.authorize,
				});
				return respond(request.batch, calls.length - 1);
			},
		},
	};
}

/** A promise with its resolver, for classifications answered late. */
function deferred<T>() {
	let resolveValue!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolveValue = resolvePromise;
	});
	return { promise, resolve: resolveValue };
}

/** Record Pi launches through the fake Herdr seam without running them. */
function usePiRecorder() {
	const launched: string[] = [];
	flow.testApi.setNativeTestSeam({
		operations: {
			createPane: () => "ai-pi-pane",
			createWorktree() {
				throw new Error("unexpected worktree creation");
			},
			async waitForShellReady() {},
			runScript(_surface: string, command: string, script: any) {
				launched.push(command);
				return script.scriptPath;
			},
			closePane() {},
		},
		terminalAvailable: true,
		piWatch: async (child: any) => ({
			name: child.name,
			task: child.task,
			summary: "Pi fixture result",
			exitCode: 0,
			elapsed: 0,
			sessionFile: child.sessionFile,
		}),
	});
	return launched;
}

type RoutingOptions = {
	mode?: (typeof ROUTING_MODES)[number];
	failurePolicy?: "parent" | "hold";
	manager?: SessionManager;
	config?: () => any;
	respond?: Respond;
	launch?: (handoff: AutoLaunchHandoff<any, any>) => Promise<AutoLaunchOutcome>;
	confirm?: (title: string, message: string, options: any) => Promise<boolean>;
	/** `throw-trigger` fails only a send that would start a parent turn. */
	send?: "append" | "defer" | "throw" | "throw-trigger";
	env?: NodeJS.ProcessEnv;
	hostMode?: string;
	setTimer?: (callback: () => void, ms: number) => () => void;
	childRunning?: (childId: string) => boolean;
	/** Replaces the scripted fake transport. */
	transport?: any;
	retained?: any;
	/** One monotonic clock for the coordinator and the fake deadline. */
	clock?: () => number;
	/** Observes each host send after it was appended. */
	onSend?: (message: any, sendOptions: any) => void;
	/** Observes each receipt write before it is appended. */
	onAppend?: (customType: string, data: any) => void;
	/** Wraps the extension's launch authority for each decision. */
	authority?: (authority: any) => any;
};

/**
 * One coordinator over a persisted parent session, the extension's launch
 * authority, and injected transport and launch handoff. Every observable
 * effect is recorded: host sends, launch handoffs, notices, and reads of the
 * idle-time `ctx.signal`.
 */
function routing(options: RoutingOptions = {}) {
	usePiRecorder();
	const manager = options.manager ?? persistedSession().manager;
	const project = mkdtempSync(join(tmpdir(), "ar-project-"));
	const counts = { classifier: 0, signal: 0, authority: 0 };
	const state = { idle: true, pending: false };
	const sends: Array<{ message: any; options: any }> = [];
	const launches: Array<AutoLaunchHandoff<any, any>> = [];
	const notices: string[] = [];
	const confirms: Array<{ title: string; message: string; options: any }> = [];
	const config =
		options.config ??
		(() => routingConfig(options.mode ?? "auto", options.failurePolicy));
	const ctx: any = {
		mode: options.hostMode ?? "tui",
		cwd: project,
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		get signal() {
			counts.signal++;
			return undefined;
		},
		sessionManager: manager,
		model: { provider: "fake", id: "parent" },
		modelRegistry: piRegistry(counts),
		ui: {
			confirm: async (title: string, message: string, dialog: any) => {
				confirms.push({ title, message, options: dialog });
				return options.confirm
					? options.confirm(title, message, dialog)
					: false;
			},
			notify: (message: string) => notices.push(message),
		},
	};
	let coordinator: ReturnType<typeof createAutoRoutingCoordinator>;
	const pi: any = {
		on() {},
		sendMessage(message: any, sendOptions: any) {
			sends.push({ message, options: sendOptions });
			if (options.send === "throw") throw new Error("send failed");
			if (options.send === "throw-trigger" && sendOptions?.triggerTurn)
				throw new Error("send failed");
			if (options.send === "defer" && !sendOptions?.triggerTurn) return;
			// The host appends to the session the context currently shows.
			ctx.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			options.onSend?.(message, sendOptions);
			// The host starts the parent turn a triggered message asks for.
			if (sendOptions?.triggerTurn) coordinator.onLifecycle("agent_start");
		},
		appendEntry(customType: string, data: any) {
			options.onAppend?.(customType, data);
			ctx.sessionManager.appendCustomEntry(customType, data);
		},
	};
	const transport = fakeTransport(options.respond, options.clock);
	coordinator = createAutoRoutingCoordinator<any, any, any>({
		pi,
		env: options.env ?? {},
		loadConfig: config,
		herdrAvailable: () => true,
		managedWorkOutstanding: () => false,
		isChildRunning:
			options.childRunning ??
			((childId) => flow.testApi.runningSubagents.has(childId)),
		authority: (context) => {
			counts.authority++;
			const authority = flow.testApi.createAutoRoutingAuthority(
				flow.api,
				context,
			);
			return options.authority ? options.authority(authority) : authority;
		},
		transport: () => options.transport ?? transport.transport,
		launch: async (handoff) => {
			launches.push(handoff);
			return options.launch
				? options.launch(handoff)
				: {
						status: "started",
						childId: "child-1",
						name: handoff.candidate.prepared.params.name,
					};
		},
		setTimer: options.setTimer,
		retained: options.retained,
		now: options.clock,
	});
	const onDisk = () =>
		readFileSync(manager.getSessionFile()!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	return {
		manager,
		ctx,
		state,
		counts,
		sends,
		launches,
		notices,
		confirms,
		transport,
		coordinator,
		onDisk,
		input: (
			text = TASK,
			source: (typeof SOURCES)[number] = "interactive",
			streaming?: "steer" | "followUp",
			images?: (typeof IMAGE)[],
		) => coordinator.onInput(inputEvent(text, source, streaming, images), ctx),
		requests: () =>
			onDisk().filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === AUTO_REQUEST_CUSTOM_TYPE,
			),
		statuses: () =>
			onDisk().filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === AUTO_STATUS_CUSTOM_TYPE,
			),
		receipts: () =>
			onDisk().filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === AUTO_RECEIPT_ENTRY_TYPE,
			),
		triggered: () => sends.filter((send) => send.options?.triggerTurn === true),
	};
}

/** The arguments of one coordinator input in these tests. */
type InputArgs = Parameters<ReturnType<typeof routing>["input"]>;
/** A host whose sends are irrelevant to the test. */
const quietHost: any = { on() {}, sendMessage() {} };
const CONTINUE = { action: "continue" };
const HANDLED = { action: "handled" };

describe("input coordinator: bypass paths make zero Jev calls", () => {
	it("continues off, invalid, non-TUI, non-interactive, streaming, child, command, and image input untouched", async () => {
		const cases: Array<[string, RoutingOptions, InputArgs]> = [
			[
				"off",
				{
					config: () => ({
						status: "off",
						source: "x",
						origin: "missing-file",
						config: { version: 1, mode: "off" },
						digest: "d",
					}),
				},
				[],
			],
			[
				"invalid",
				{
					config: () => ({ status: "invalid", source: "x", diagnostic: "bad" }),
				},
				[],
			],
			...HOST_MODES.filter((mode) => mode !== "tui").map(
				(hostMode): [string, RoutingOptions, InputArgs] => [
					`mode ${hostMode}`,
					{ hostMode },
					[],
				],
			),
			["rpc source", {}, [TASK, "rpc"]],
			["extension source", {}, [TASK, "extension"]],
			["steer", {}, [TASK, "interactive", "steer"]],
			["followUp", {}, [TASK, "interactive", "followUp"]],
			["child", { env: { PI_SUBAGENT_ID: "child" } }, []],
			["recursion guard", { env: { [AUTO_ROUTING_DISABLED_ENV]: "1" } }, []],
			["manual command", {}, ["/subagent ai-reporter do it"]],
			["shell", {}, ["!ls"]],
			["image", {}, [TASK, "interactive", undefined, [IMAGE]]],
			["opt-out", {}, [`${TASK} [no-auto-route]`]],
		];
		for (const mode of ROUTING_MODES)
			for (const [label, options, args] of cases) {
				const run = routing({ mode, ...options });
				assert.deepEqual(
					await run.input(...args),
					CONTINUE,
					`${mode} ${label}`,
				);
				await run.coordinator.settled();
				assert.equal(run.transport.calls.length, 0, `${mode} ${label}`);
				assert.equal(run.counts.authority, 0, `${mode} ${label}`);
				assert.equal(
					run.sends.length + run.launches.length,
					0,
					`${mode} ${label}`,
				);
				assert.equal(run.receipts().length, 0, `${mode} ${label}`);
				assert.equal(run.counts.signal + run.counts.classifier, 0);
				assert.equal(run.coordinator.snapshotStatus().pending, undefined);
			}
	});

	it("bypasses the first prompt of a session the host has not written yet", async () => {
		const root = mkdtempSync(join(tmpdir(), "ar-new-"));
		const manager = SessionManager.create(root, join(root, "sessions"));
		const run = routing({ manager });
		assert.deepEqual(await run.input(), CONTINUE);
		assert.equal(run.transport.calls.length + run.sends.length, 0);
		assert.equal(
			existsSync(manager.getSessionFile()!),
			false,
			"no flush is forced",
		);
	});

	it("bypasses while managed work or dispatched automatic work is outstanding", async () => {
		let running = true;
		const run = routing({ childRunning: () => running });
		assert.deepEqual(await run.input(), HANDLED);
		assert.equal(run.launches.length, 1);
		// The dispatched child keeps the slot busy; later prompts are ordinary.
		assert.deepEqual(await run.input("Another request."), CONTINUE);
		assert.equal(run.transport.calls.length, 2, "no egress while busy");
		assert.match(run.coordinator.cancel().message, /does not terminate it/);
		// Once the existing lifecycle settles the child, routing resumes.
		running = false;
		assert.deepEqual(await run.input("A third request."), HANDLED);
		assert.equal(run.transport.calls.length, 4);

		const busy = routing();
		const shared = createAutoRoutingCoordinator<any, any, any>({
			pi: quietHost,
			loadConfig: () => routingConfig("auto"),
			herdrAvailable: () => true,
			managedWorkOutstanding: () => true,
			isChildRunning: () => false,
			authority: () => {
				throw new Error("never prepared while busy");
			},
			transport: () => busy.transport.transport,
			launch: async () => {
				throw new Error("never launched while busy");
			},
		});
		assert.deepEqual(
			await shared.onInput(inputEvent(TASK), busy.ctx),
			CONTINUE,
		);
		assert.equal(busy.transport.calls.length, 0);
	});
});

describe("input coordinator: reservation, ownership, and persistence", () => {
	it("reserves one slot synchronously with a random package decision ID", async () => {
		const answer = deferred<any>();
		const run = routing({ respond: () => answer.promise });
		const pending = run.input();
		// Reserved before the first await: visible without yielding.
		const status = run.coordinator.snapshotStatus();
		assert.match(status.pending!.decisionId, /^ad-[0-9a-f-]{36}$/);
		assert.equal(status.pending!.owned, false);
		assert.equal(status.pending!.phase, "classifying");
		answer.resolve({
			status: "unavailable",
			reason: "jev-timeout",
			detail: "t",
		});
		assert.deepEqual(await pending, CONTINUE);
		const again = routing();
		await again.input();
		assert.notEqual(
			again.receipts()[0].data.decisionId,
			run.receipts()[0].data.decisionId,
		);
		assert.equal(run.counts.signal, 0, "ctx.signal is never an idle cancel");
	});

	it("continues unowned abstention and unavailability under the parent policy", async () => {
		for (const respond of [
			(batch: any) => evidenceResult(batch, true),
			() => ({ status: "unavailable", reason: "jev-timeout", detail: "late" }),
			() => ({
				status: "unavailable",
				reason: "jev-auth-unavailable",
				detail: "x",
			}),
		]) {
			const run = routing({ respond });
			assert.deepEqual(await run.input(), CONTINUE);
			assert.equal(run.sends.length, 0, "no replacement or fallback message");
			assert.equal(run.launches.length, 0);
			assert.equal(run.requests().length, 0);
			const [receipt] = run.receipts();
			assert.equal(receipt.data.phase, "continued");
			assert.equal(receipt.data.owned, false);
			// Receipts carry codes and hashes only: never prompt or probabilities.
			const text = JSON.stringify(run.receipts());
			assert.equal(text.includes("parser module"), false);
			assert.equal(text.includes("probabilit"), false);
		}
	});

	it("holds unowned abstention under the hold policy with the request recorded", async () => {
		const run = routing({
			failurePolicy: "hold",
			respond: (batch) => evidenceResult(batch, true),
		});
		assert.deepEqual(await run.input(), HANDLED);
		const [request] = run.requests();
		assert.equal(request.details.state, "held");
		assert.equal(request.details.reason, "no-role-fit");
		assert.equal(
			extractAutoRequestText(request.content, request.details.decisionId),
			TASK,
		);
		assert.equal(run.launches.length + run.triggered().length, 0);
		assert.equal(
			run.transport.calls.length,
			1,
			"Batch B is omitted after A abstains",
		);
	});

	it("records and verifies the exact request on disk before the launch handoff", async () => {
		let seenOnDisk: any;
		const run = routing({
			launch: async (handoff) => {
				// The request exists in the real artifact before any dispatch.
				seenOnDisk = run
					.requests()
					.find((entry) => entry.details.decisionId === handoff.decisionId);
				return { status: "started", childId: "child-7", name: "auto" };
			},
		});
		const text = `${TASK}\n  <file>notes.md</file> keeps its bytes.`;
		assert.deepEqual(await run.input(text), HANDLED);
		assert.ok(seenOnDisk, "request persisted before dispatch");
		assert.equal(seenOnDisk.details.state, "accepted");
		assert.equal(seenOnDisk.display, true);
		assert.equal(
			extractAutoRequestText(seenOnDisk.content, seenOnDisk.details.decisionId),
			text,
		);
		assert.equal(run.transport.calls.length, 2);
		assert.equal(
			run.transport.calls[0].deadline,
			run.transport.calls[1].deadline,
			"one monotonic deadline for A and B",
		);
		assert.equal(run.transport.deadlines.length, 1);
		for (const call of run.transport.calls) {
			assert.equal(call.signals.length, 1);
			assert.equal(call.signals[0].aborted, false);
		}
		assert.equal(run.launches.length, 1);
		const handoff = run.launches[0];
		assert.equal(handoff.route.agent, ROUTED_ROLE);
		assert.equal(handoff.route.harness, "pi");
		assert.equal(handoff.candidate.prepared.params.task, text);
		// Success adds only a non-triggering status; delivery stays with the child.
		assert.equal(run.triggered().length, 0);
		const [started] = run.statuses();
		assert.equal(started.details.state, "started");
		assert.equal(started.details.childId, "child-7");
		assert.equal(started.details.model, "fake/exact-2");
		assert.equal(started.details.effort, "high");
		assert.equal(started.details.roleSource, "global");
		assert.equal(
			run.coordinator.snapshotStatus().retained?.state,
			"dispatched",
		);
	});

	it("holds without launching when the request write is deferred or fails", async () => {
		for (const send of ["defer", "throw"] as const) {
			const run = routing({ send });
			assert.deepEqual(await run.input(), HANDLED, send);
			assert.equal(run.launches.length, 0, send);
			assert.equal(run.triggered().length, 0, send);
			assert.equal(run.requests().length, 0, send);
			// One attempted record only; no retry and no second held copy.
			assert.equal(run.sends.length, 1, send);
			assert.match(run.notices.join("\n"), /held a request/);
			assert.equal(run.notices.join("\n").includes("parser module"), false);
			assert.equal(
				run.coordinator.snapshotStatus().last?.reason,
				"request-record-failed",
			);
		}
	});
});

describe("input coordinator: drift, cancellation, and late answers", () => {
	it("holds without a record when the session generation changes mid-classification", async () => {
		const answer = deferred<any>();
		const run = routing({ respond: () => answer.promise });
		const pending = run.input();
		run.coordinator.onLifecycle("session_tree");
		answer.resolve(evidenceResult(run.transport.calls[0].batch));
		assert.deepEqual(await pending, HANDLED);
		assert.equal(run.launches.length + run.sends.length, 0);
		assert.equal(
			run.transport.calls.length,
			1,
			"no Batch B after cancellation",
		);
		assert.equal(run.transport.calls[0].signals[0].aborted, true);
	});

	it("holds on an unrelated branch append and records nothing into the moved branch", async () => {
		const answer = deferred<any>();
		const run = routing({ respond: () => answer.promise });
		const pending = run.input();
		run.manager.appendCustomEntry("unrelated", { note: 1 });
		answer.resolve(evidenceResult(run.transport.calls[0].batch));
		assert.deepEqual(await pending, HANDLED);
		assert.equal(run.launches.length, 0);
		assert.equal(run.requests().length, 0);
	});

	it("ignores a late answer after a local cancel and keeps the request held", async () => {
		const answer = deferred<any>();
		const run = routing({ respond: () => answer.promise });
		const pending = run.input();
		const report = run.coordinator.cancel();
		assert.equal(report.cancelled, true);
		assert.match(report.message, /held/);
		// The late, valid selection cannot launch.
		answer.resolve(evidenceResult(run.transport.calls[0].batch));
		assert.deepEqual(await pending, HANDLED);
		assert.equal(run.launches.length, 0);
		const [request] = run.requests();
		assert.equal(request.details.state, "held");
		assert.equal(request.details.reason, "user-cancelled");
		assert.equal(run.coordinator.cancel().cancelled, false);
	});

	it("holds on parent agent_start and shutdown before dispatch", async () => {
		for (const [event, reason] of [
			["agent_start", "parent-started"],
			["session_shutdown", "shutdown"],
		] as const) {
			const answer = deferred<any>();
			const run = routing({ respond: () => answer.promise });
			const pending = run.input();
			run.coordinator.onLifecycle(event);
			answer.resolve(evidenceResult(run.transport.calls[0].batch));
			assert.deepEqual(await pending, HANDLED, event);
			assert.equal(run.launches.length, 0, event);
			assert.equal(run.coordinator.snapshotStatus().last?.reason, reason);
		}
	});

	it("supersedes an older undispatched decision and continues the new input", async () => {
		const answer = deferred<any>();
		const run = routing({ respond: () => answer.promise });
		const older = run.input();
		assert.deepEqual(await run.input("A different request."), CONTINUE);
		answer.resolve(evidenceResult(run.transport.calls[0].batch));
		assert.deepEqual(await older, HANDLED);
		assert.equal(run.transport.calls.length, 1, "the new input made no call");
		assert.equal(run.launches.length, 0);
		assert.equal(run.coordinator.snapshotStatus().last?.reason, "superseded");
	});

	it("continues unowned config drift under the parent policy and never reclassifies", async () => {
		let durable = routingConfig("auto", "parent");
		const run = routing({
			config: () => durable,
			respond: (batch, index) => {
				// The approvals change while Batch B is answered.
				if (index === 1) durable = routingConfig("auto", "parent", "xhigh");
				return evidenceResult(batch);
			},
		});
		assert.deepEqual(await run.input(), CONTINUE);
		assert.equal(run.transport.calls.length, 2);
		assert.equal(run.requests().length + run.launches.length, 0);
		assert.equal(run.coordinator.snapshotStatus().last?.reason, "config-drift");
	});

	it("falls back to the parent at most once after owned drift with the request verified", async () => {
		let durable = routingConfig("auto", "parent");
		const run = routing({
			config: () => durable,
			// The durable config changes once the request is owned and recorded.
			onSend: (message) => {
				if (message.customType === AUTO_REQUEST_CUSTOM_TYPE)
					durable = routingConfig("auto", "parent", "xhigh");
			},
		});
		assert.deepEqual(await run.input(), HANDLED);
		assert.equal(run.launches.length, 0);
		const triggered = run.triggered();
		assert.equal(triggered.length, 1);
		assert.equal(triggered[0].options.deliverAs, "steer");
		assert.equal(triggered[0].message.details.state, "fallback-parent");
		assert.equal(triggered[0].message.details.reason, "stale-snapshot");
		assert.match(triggered[0].message.content, /No subagent was launched/);
		assert.ok(triggered[0].message.content.includes(TASK));
		// The fallback's own parent turn did not cancel or replay it.
		assert.equal(
			run.coordinator.snapshotStatus().last?.phase,
			"fallback-attempted",
		);
		assert.equal(run.requests()[0].details.state, "accepted");
	});

	it("holds owned drift under the hold policy", async () => {
		let durable = routingConfig("auto", "hold");
		const run = routing({
			failurePolicy: "hold",
			config: () => durable,
			onSend: (message) => {
				if (message.customType === AUTO_REQUEST_CUSTOM_TYPE)
					durable = routingConfig("auto", "hold", "xhigh");
			},
		});
		assert.deepEqual(await run.input(), HANDLED);
		assert.equal(run.launches.length + run.triggered().length, 0);
		assert.equal(run.statuses()[0].details.state, "held");
	});

	it("uses fallback only for a known no-dispatch rejection and keeps uncertain work busy", async () => {
		const rejected = routing({
			launch: async () => ({
				status: "rejected",
				detail: "prepared-run-stale",
			}),
		});
		assert.deepEqual(await rejected.input(), HANDLED);
		assert.equal(rejected.triggered().length, 1);
		assert.equal(
			rejected.triggered()[0].message.details.reason,
			"launch-rejected",
		);

		const uncertain = routing({
			launch: async () => {
				throw new Error("runScript may have sent a command");
			},
		});
		assert.deepEqual(await uncertain.input(), HANDLED);
		assert.equal(uncertain.triggered().length, 0, "never parent replay");
		assert.equal(uncertain.statuses()[0].details.state, "uncertain");
		assert.equal(
			uncertain.coordinator.snapshotStatus().retained?.state,
			"uncertain",
		);
		assert.match(uncertain.coordinator.cancel().message, /may have dispatched/);
		// Unknown is not no-work: later prompts bypass without egress.
		const calls = uncertain.transport.calls.length;
		assert.deepEqual(await uncertain.input("Another request."), CONTINUE);
		assert.equal(uncertain.transport.calls.length, calls);
	});
});

describe("input coordinator: shadow and pilot", () => {
	it("shadow continues at once and observes without context, request, or launch effects", async () => {
		const answer = deferred<any>();
		const run = routing({
			mode: "shadow",
			respond: (batch, index) =>
				index === 0 ? answer.promise : evidenceResult(batch),
		});
		const before = run.onDisk().length;
		assert.deepEqual(await run.input(), CONTINUE);
		// Parent work does not cancel observation.
		run.coordinator.onLifecycle("agent_start");
		answer.resolve(evidenceResult(run.transport.calls[0].batch));
		await run.coordinator.settled();
		assert.equal(run.transport.calls.length, 2);
		assert.equal(run.sends.length + run.launches.length, 0);
		const added = run.onDisk().slice(before);
		assert.deepEqual(
			added.map((entry) => entry.type),
			["custom"],
			"only a non-context receipt",
		);
		assert.equal(added[0].data.phase, "observed");
		assert.equal(added[0].data.candidateId, "c000");
		assert.equal(JSON.stringify(added).includes("parser module"), false);
	});

	it("shadow stops on observed session replacement and skips while busy", async () => {
		const answer = deferred<any>();
		const run = routing({ mode: "shadow", respond: () => answer.promise });
		assert.deepEqual(await run.input(), CONTINUE);
		// A busy observer never delays or supersedes another prompt.
		assert.deepEqual(await run.input("Second prompt."), CONTINUE);
		assert.equal(run.transport.calls.length, 1);
		run.coordinator.onLifecycle("session_tree");
		answer.resolve(evidenceResult(run.transport.calls[0].batch));
		await run.coordinator.settled();
		assert.equal(run.transport.calls.length, 1, "no Batch B after replacement");
		assert.equal(run.receipts().length, 0, "no receipt into a changed session");
	});

	it("pilot launches only after an explicit yes, bounded and revalidated", async () => {
		const run = routing({ mode: "pilot", confirm: async () => true });
		assert.deepEqual(await run.input(), HANDLED);
		assert.equal(run.launches.length, 1);
		const [dialog] = run.confirms;
		assert.equal(dialog.options.timeout, AUTO_PILOT_CONFIRM_TIMEOUT_MS);
		assert.ok(dialog.options.signal);
		assert.match(dialog.message, /Role: ai-reporter \(global\)/);
		assert.match(dialog.message, /Model: fake\/exact-2/);
		assert.match(
			dialog.message,
			/Escape during classification was not a cancellation guarantee/,
		);
		// The request was recorded before the question was asked.
		assert.equal(run.requests()[0].details.state, "accepted");
	});

	it("pilot holds on decline, timeout, dialog failure, and cancel; never defaults to yes", async () => {
		const declined = routing({ mode: "pilot", confirm: async () => false });
		assert.deepEqual(await declined.input(), HANDLED);
		assert.equal(
			declined.coordinator.snapshotStatus().last?.reason,
			"pilot-declined",
		);

		const timedOut = routing({
			mode: "pilot",
			confirm: () => new Promise(() => undefined),
			setTimer: (callback) => {
				queueMicrotask(callback);
				return () => undefined;
			},
		});
		assert.deepEqual(await timedOut.input(), HANDLED);
		assert.equal(
			timedOut.coordinator.snapshotStatus().last?.reason,
			"pilot-timeout",
		);
		assert.equal(
			timedOut.confirms[0].options.signal.aborted,
			true,
			"dialog dismissed",
		);

		const failing = routing({
			mode: "pilot",
			confirm: async () => {
				throw new Error("dialog unavailable");
			},
		});
		assert.deepEqual(await failing.input(), HANDLED);
		assert.equal(
			failing.coordinator.snapshotStatus().last?.reason,
			"internal-error",
		);

		let cancel: () => void = () => undefined;
		const cancelled = routing({
			mode: "pilot",
			confirm: (_title, _message, dialog) =>
				new Promise((resolveDialog) => {
					dialog.signal.addEventListener("abort", () => resolveDialog(true));
					cancel();
				}),
		});
		cancel = () => cancelled.coordinator.cancel();
		assert.deepEqual(await cancelled.input(), HANDLED);
		assert.equal(
			cancelled.coordinator.snapshotStatus().last?.reason,
			"user-cancelled",
		);

		for (const run of [declined, timedOut, failing, cancelled]) {
			assert.equal(run.launches.length, 0);
			assert.equal(run.triggered().length, 0);
			assert.equal(run.statuses()[0].details.state, "held");
		}
	});

	it("pilot without dialog support bypasses before any egress", async () => {
		const run = routing({ mode: "pilot" });
		delete run.ctx.ui.confirm;
		assert.deepEqual(await run.input(), CONTINUE);
		assert.equal(run.transport.calls.length, 0);
	});
});

describe("input coordinator: real launch handoff and delivery", () => {
	it("starts through startSubagentRun and delivers only the ordinary child result", async () => {
		const sentBefore = flow.sent.length;
		let host: ReturnType<typeof routing>;
		host = routing({
			launch: (handoff) => flow.testApi.launchAutoRoutedRun(flow.api, handoff),
		});
		assert.deepEqual(await host.input(), HANDLED);
		const [started] = host.statuses();
		assert.equal(started.details.state, "started");
		const result = await flow.waitForMessage(
			(message) =>
				message.customType === "subagent_result" &&
				message.details?.name === started.details.name,
		);
		assert.equal(result.details.selection.harnessSource, "auto");
		assert.equal(result.details.runtimeProvenance.model.source, "auto");
		assert.match(result.content, /Automatically selected model: fake\/exact-2/);
		assert.doesNotMatch(result.content, /Requested model/);
		// No extra parent wake-up beyond the existing result delivery, and the
		// delivered result is never classified again.
		assert.equal(host.triggered().length, 0);
		assert.equal(host.transport.calls.length, 2);
		assert.equal(
			flow.sent
				.slice(sentBefore)
				.filter((message) => message.customType === "subagent_result").length,
			1,
		);
	});
});

describe("request and status rendering", () => {
	it("shows the exact handler-visible request, escaped and labeled", () => {
		const id = "ad-00000000-0000-4000-8000-000000000000";
		const hostile = "line one\u001b[31m red\u202e evil\tend\nline two";
		const content = formatAutoRequestContent(id, hostile, "accepted");
		assert.equal(extractAutoRequestText(content, id), hostile);
		// A request cannot forge its own end marker without the random ID.
		const forged = formatAutoRequestContent(
			id,
			"x\n----- END REQUEST ad-other -----\ny",
			"accepted",
		);
		assert.equal(
			extractAutoRequestText(forged, id),
			"x\n----- END REQUEST ad-other -----\ny",
		);
		const view = autoRequestView(
			{ content, details: { version: 1, decisionId: id, state: "accepted" } },
			true,
		);
		assert.equal(
			view.title,
			"User request · automatic delegation · handler-visible text",
		);
		assert.deepEqual(view.lines.slice(0, 2), [
			"line one\\u{1b}[31m red\\u{202e} evil    end",
			"line two",
		]);
		assert.ok(view.lines.includes(`Decision: ${id}`));
		// Raw controls and bidirectional overrides must be absent.
		// oxlint-disable-next-line no-control-regex
		const raw = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e]/;
		for (const line of view.lines) assert.doesNotMatch(line, raw);

		const held = autoRequestView(
			{
				content: formatAutoRequestContent(id, "t", "held", "pilot-declined"),
				details: { decisionId: id, state: "held", reason: "pilot-declined" },
			},
			false,
		);
		assert.match(held.title, /held \(pilot-declined\)$/);
		const unknown = autoRequestView(
			{
				content: "free text",
				details: { decisionId: id, state: "held", reason: "\u001b[2J" },
			},
			false,
		);
		assert.match(unknown.lines[0], /markers are missing/);
		assert.equal(unknown.title.includes("\u001b"), false);
	});

	it("bounds previews and expanded views without truncating the stored request", () => {
		const id = "ad-1";
		const long = Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n");
		const content = formatAutoRequestContent(id, long, "accepted");
		const preview = autoRequestView(
			{ content, details: { decisionId: id } },
			false,
		);
		assert.equal(preview.lines.length, 5);
		assert.equal(preview.omitted, 895);
		const expanded = autoRequestView(
			{ content, details: { decisionId: id } },
			true,
		);
		assert.equal(expanded.omitted, 0);
		assert.equal(expanded.lines[899], "line 899");
		assert.equal(extractAutoRequestText(content, id), long);
		// Content no admitted request can produce is still bounded.
		const huge = "x\n".repeat(AUTO_MESSAGE_VIEW_LIMITS.expandedLines + 10);
		const bounded = autoRequestView({ content: huge, details: {} }, true);
		assert.ok(bounded.omitted > 0);
		assert.ok(
			bounded.lines.length <= AUTO_MESSAGE_VIEW_LIMITS.expandedLines + 1,
		);
	});

	it("labels status tuples as automatically selected, never requested", () => {
		const view = autoStatusView(
			{
				content: "Automatic delegation started subagent.",
				details: {
					decisionId: "ad-1",
					state: "started",
					childId: "c-1",
					name: "auto",
					agent: "ai-reporter",
					roleSource: "global",
					harness: "pi",
					model: "fake/exact-2\u001b]0;x\u0007",
					effort: "high",
				},
			},
			false,
		);
		assert.equal(view.title, "Automatic delegation · started");
		assert.ok(view.lines.includes("Role: ai-reporter (global)"));
		assert.ok(
			view.lines.includes(
				"Automatically selected: pi · fake/exact-2\\u{1b}]0;x\\u{7} · high",
			),
		);
		assert.equal(
			view.lines.some((line) => /Requested/.test(line)),
			false,
		);
		assert.equal(
			autoStatusView({ content: "", details: { state: "?" } }, false).title,
			"Automatic delegation · status",
		);
		assert.equal(escapeTerminalText("a\r\nb"), "a\\u{d}\nb");
	});

	it("reports local status and cancellation limits truthfully", async () => {
		const run = routing();
		const idle = formatAutoRoutingStatus(run.coordinator.snapshotStatus());
		assert.match(idle, /Automatic routing: auto/);
		assert.match(idle, /No decision is pending/);
		assert.match(idle, /TUI Escape is not a cancellation guarantee/);
		assert.match(idle, /never terminates a running child/);
		assert.equal(
			run.coordinator.cancel().message,
			"No automatic routing decision is pending.",
		);
		await run.input();
		const status = run.coordinator.snapshotStatus();
		assert.equal(status.retained?.childId, "child-1");
		assert.match(
			formatAutoRoutingStatus(status),
			/Last decision ad-.* dispatched/,
		);
	});
});

/** An off configuration as the loader reports a missing file. */
const OFF_CONFIG = Object.freeze({
	status: "off",
	source: "x",
	origin: "missing-file",
	config: { version: 1, mode: "off" },
	digest: "off-digest",
});

/** A test clock shared by the coordinator and the fake deadline. */
function testClock() {
	let value = 0;
	return {
		now: () => value,
		advance: (ms: number) => {
			value += ms;
		},
	};
}

/**
 * The real transport over a fake host registry whose authentication is
 * pending until released, then forwards the exact batch body through the
 * per-call observing fetch. `forwarded` counts what reached the network.
 */
function authGatedTransport() {
	const forwarded: any[] = [];
	const entered: Array<ReturnType<typeof deferred<void>>> = [];
	const releases: Array<() => void> = [];
	let batch: any;
	const registry = {
		findOfType: (type: string, provider: string, modelId: string) =>
			type === "classifier" &&
			provider === "typesafe" &&
			modelId === "jev-latest"
				? { ...TYPESAFE_CLASSIFIER_MODELS["jev-latest"] }
				: undefined,
		hasConfiguredAuth: () => true,
		async classify(_model: any, _context: any, callOptions: any) {
			const auth = deferred<void>();
			releases.push(() => auth.resolve());
			entered.at(-1)?.resolve();
			await auth.promise;
			await callOptions.fetch(JEV_CLASSIFIER_ENDPOINT, {
				method: "POST",
				body: batch.wireBody,
			});
			throw new Error("This fixture never answers.");
		},
	};
	const real = createJevTransport({
		registry,
		fetch: async (...args: any[]) => {
			forwarded.push(args);
			throw new Error("network");
		},
	});
	return {
		forwarded,
		/** Resolves once the next classification is inside authentication. */
		nextAuth: () => {
			const signal = deferred<void>();
			entered.push(signal);
			return signal.promise;
		},
		releaseAuth: () => releases.shift()?.(),
		transport: {
			createDeadline: real.createDeadline,
			classify: (request: any) => {
				batch = request.batch;
				return real.classify(request);
			},
		},
	};
}

describe("input coordinator: config revocation during classification (F001)", () => {
	it("sends no Batch B after the config is revoked, deleted, or changed while A is pending", async () => {
		const changes: Array<[string, () => any]> = [
			["revoked", () => ({ ...OFF_CONFIG, origin: "file" })],
			["deleted", () => OFF_CONFIG],
			["changed", () => routingConfig("auto", "parent", "xhigh")],
			[
				"invalid",
				() => ({ status: "invalid", source: "x", diagnostic: "bad" }),
			],
		];
		for (const mode of ROUTING_MODES)
			for (const failurePolicy of ["parent", "hold"] as const)
				for (const [label, change] of changes) {
					const tag = `${mode} ${failurePolicy} ${label}`;
					const answer = deferred<any>();
					let durable: any = routingConfig(mode, failurePolicy);
					const run = routing({
						mode,
						failurePolicy,
						config: () => durable,
						confirm: async () => true,
						respond: () => answer.promise,
					});
					const pending = run.input();
					assert.equal(run.transport.calls[0].authorize?.(), true, tag);
					durable = change();
					// The pre-forward hook refuses as soon as the config differs.
					assert.equal(run.transport.calls[0].authorize?.(), false, tag);
					answer.resolve(evidenceResult(run.transport.calls[0].batch));
					const result = await pending;
					await run.coordinator.settled();
					assert.equal(run.transport.calls.length, 1, `${tag}: no Batch B`);
					assert.equal(run.launches.length, 0, tag);
					assert.equal(run.triggered().length, 0, tag);
					if (mode === "shadow") {
						assert.deepEqual(result, CONTINUE, tag);
						assert.equal(run.receipts()[0].data.reason, "config-drift", tag);
						continue;
					}
					assert.deepEqual(
						result,
						failurePolicy === "hold" ? HANDLED : CONTINUE,
						tag,
					);
					assert.equal(
						run.coordinator.snapshotStatus().last?.reason,
						"config-drift",
						tag,
					);
					if (failurePolicy === "parent")
						assert.equal(run.requests().length, 0, tag);
				}
	});

	it("forwards nothing when the config is revoked while host authentication is pending", async () => {
		for (const mode of ROUTING_MODES) {
			let durable: any = routingConfig(mode);
			const gated = authGatedTransport();
			const run = routing({
				mode,
				config: () => durable,
				transport: gated.transport,
			});
			const inAuth = gated.nextAuth();
			const pending = run.input();
			await inAuth;
			durable = OFF_CONFIG;
			gated.releaseAuth();
			await pending;
			await run.coordinator.settled();
			assert.equal(gated.forwarded.length, 0, `${mode}: nothing forwarded`);
			assert.equal(run.launches.length, 0, mode);
			assert.equal(
				run.coordinator.snapshotStatus().last?.reason,
				"config-drift",
				mode,
			);
		}
	});

	it("still forwards through the hook while the config is unchanged", async () => {
		const gated = authGatedTransport();
		const run = routing({ transport: gated.transport });
		const inAuth = gated.nextAuth();
		const pending = run.input();
		await inAuth;
		gated.releaseAuth();
		assert.deepEqual(await pending, CONTINUE);
		assert.equal(gated.forwarded.length, 1, "the unchanged request is sent");
	});
});

describe("input coordinator: configuration is initialized once per load (F003)", () => {
	it("never activates a later durable change without a reload", async () => {
		const transitions: Array<[string, any, any]> = [
			["off to auto", OFF_CONFIG, routingConfig("auto")],
			["shadow to auto", routingConfig("shadow"), routingConfig("auto")],
			[
				"approval change",
				routingConfig("auto"),
				routingConfig("auto", "parent", "xhigh"),
			],
			[
				"policy change",
				routingConfig("auto", "parent"),
				routingConfig("auto", "hold"),
			],
			["auto to off", routingConfig("auto"), OFF_CONFIG],
			[
				"invalid to auto",
				{ status: "invalid", source: "x", diagnostic: "bad" },
				routingConfig("auto"),
			],
		];
		for (const [label, initial, later] of transitions) {
			let durable = initial;
			const run = routing({ config: () => durable });
			const loaded = run.coordinator.snapshotStatus();
			assert.equal(loaded.configChanged, false, label);
			durable = later;
			for (let attempt = 0; attempt < 2; attempt++)
				assert.deepEqual(await run.input(), CONTINUE, label);
			await run.coordinator.settled();
			assert.equal(run.transport.calls.length, 0, `${label}: no egress`);
			assert.equal(run.counts.authority, 0, label);
			assert.equal(run.receipts().length + run.sends.length, 0, label);
			const status = run.coordinator.snapshotStatus();
			assert.equal(status.config, loaded.config, `${label}: loaded snapshot`);
			assert.equal(status.configChanged, true, label);
			assert.match(formatAutoRoutingStatus(status), /after \/reload/);
			assert.equal(
				run.coordinator.configuration(),
				run.coordinator.configuration(),
			);
		}
	});

	it("activates a durable change only in a newly loaded coordinator", async () => {
		let durable: any = OFF_CONFIG;
		const first = routing({ config: () => durable });
		durable = routingConfig("auto");
		assert.deepEqual(await first.input(), CONTINUE);
		const reloaded = routing({ manager: first.manager, config: () => durable });
		assert.deepEqual(await reloaded.input(), HANDLED);
		assert.equal(reloaded.launches.length, 1);
	});
});

describe("input coordinator: durable unknown work at startup (F002)", () => {
	const ID = (n: number) => `ad-0000000${n}-0000-4000-8000-000000000000`;

	function acceptedRequest(manager: SessionManager, decisionId: string) {
		manager.appendCustomMessageEntry(
			AUTO_REQUEST_CUSTOM_TYPE,
			formatAutoRequestContent(decisionId, TASK, "accepted"),
			true,
			{ version: 1, decisionId, source: "interactive", state: "accepted" },
		);
	}

	function receipt(manager: SessionManager, decisionId: string, phase: string) {
		manager.appendCustomEntry(AUTO_RECEIPT_ENTRY_TYPE, {
			version: 1,
			decisionId,
			mode: "auto",
			phase,
			owned: true,
		});
	}

	/** A fresh process over the same on-disk session. */
	function restart(manager: SessionManager) {
		const file = manager.getSessionFile()!;
		return SessionManager.open(file, join(file, ".."));
	}

	it("blocks classification and launch after a crash following an accepted request", async () => {
		const launched = deferred<void>();
		const crashed = routing({
			launch: () => {
				launched.resolve();
				return new Promise(() => undefined);
			},
		});
		void crashed.input();
		// The process dies once the request is recorded, before any outcome.
		await launched.promise;
		assert.equal(crashed.requests().length, 1);
		assert.equal(crashed.launches.length, 1);

		const run = routing({ manager: restart(crashed.manager) });
		const recovery = run.coordinator.recover(run.ctx);
		assert.equal(recovery.status, "unknown");
		if (recovery.status !== "unknown") throw new Error("unreachable");
		assert.equal(recovery.work[0].evidence, "accepted");
		assert.equal(
			recovery.work[0].decisionId,
			crashed.requests()[0].details.decisionId,
		);
		for (const mode of ROUTING_MODES) {
			const blocked = routing({ mode, manager: restart(crashed.manager) });
			blocked.coordinator.recover(blocked.ctx);
			assert.deepEqual(await blocked.input(), CONTINUE, mode);
			await blocked.coordinator.settled();
			assert.equal(blocked.transport.calls.length, 0, `${mode}: no egress`);
			assert.equal(blocked.launches.length + blocked.sends.length, 0, mode);
		}
		const text = formatAutoRoutingStatus(run.coordinator.snapshotStatus());
		assert.match(text, /Unknown: decision ad-.* accepted-request evidence/);
		assert.match(text, /never replayed, adopted, or retried/);
	});

	it("blocks after possible dispatch and never infers completion", async () => {
		const dispatched = routing({ childRunning: () => false });
		assert.deepEqual(await dispatched.input(), HANDLED);
		const uncertain = routing({
			launch: async () => {
				throw new Error("runScript may have sent a command");
			},
		});
		assert.deepEqual(await uncertain.input(), HANDLED);
		for (const [label, source, evidence] of [
			["dispatched", dispatched, "dispatched"],
			["uncertain", uncertain, "uncertain"],
		] as const) {
			// The earlier process saw the child settle; a restart cannot know.
			const run = routing({ manager: restart(source.manager) });
			assert.deepEqual(await run.input(), CONTINUE, label);
			assert.equal(run.transport.calls.length, 0, label);
			assert.equal(run.launches.length, 0, label);
			const recovery = run.coordinator.snapshotStatus().recovery;
			assert.equal(recovery?.status, "unknown", label);
			if (recovery?.status !== "unknown") throw new Error("unreachable");
			assert.equal(recovery.work[0].evidence, evidence, label);
			assert.match(run.coordinator.cancel().message, /No automatic routing/);
		}
	});

	it("creates no unknown work from held, continued, observed, or fallback outcomes", async () => {
		const sources = [
			routing({
				failurePolicy: "hold",
				respond: (b) => evidenceResult(b, true),
			}),
			routing({ respond: (b) => evidenceResult(b, true) }),
			routing({ launch: async () => ({ status: "rejected", detail: "x" }) }),
			routing({ mode: "pilot", confirm: async () => false }),
		];
		const shadow = routing({ mode: "shadow" });
		await shadow.input();
		await shadow.coordinator.settled();
		for (const source of sources) await source.input();
		for (const [index, source] of [...sources, shadow].entries()) {
			assert.ok(source.receipts().length > 0, `case ${index} left evidence`);
			const run = routing({ manager: restart(source.manager) });
			assert.deepEqual(run.coordinator.recover(run.ctx), { status: "clear" });
			assert.deepEqual(
				await run.input("A later request."),
				HANDLED,
				`${index}`,
			);
			assert.equal(run.launches.length, 1, `case ${index}`);
		}
	});

	it("reads only well-formed decision evidence and treats an unreadable branch as blocking", () => {
		const { manager } = persistedSession();
		acceptedRequest(manager, ID(1));
		receipt(manager, ID(1), "held");
		acceptedRequest(manager, ID(2));
		receipt(manager, ID(2), "dispatched");
		receipt(manager, ID(2), "held");
		receipt(manager, ID(3), "uncertain");
		acceptedRequest(manager, "not-a-decision");
		receipt(manager, "ad-forged", "dispatched");
		manager.appendCustomEntry("unrelated", {
			decisionId: ID(4),
			phase: "dispatched",
		});
		/** Recovery over any branch source, including hostile fixtures. */
		const recoverFrom = (
			sessionManager: any,
			known?: (id: string) => boolean,
		) => recoverAutoRoutingWork({ sessionManager }, known);
		const recovery = recoverFrom(manager);
		assert.deepEqual(recovery, {
			status: "unknown",
			work: [
				{ decisionId: ID(2), evidence: "dispatched" },
				{ decisionId: ID(3), evidence: "uncertain" },
			],
			total: 2,
		});
		// Decisions this process already accounts for defer to memory.
		assert.deepEqual(
			recoverFrom(manager, (id) => [ID(2), ID(3)].includes(id)),
			{ status: "clear" },
		);
		const hostile = {
			getBranch: () => [
				{
					type: "custom",
					get customType(): string {
						throw new Error("hostile getter");
					},
				},
			],
		};
		assert.deepEqual(recoverFrom(hostile), { status: "clear" });
		for (const sessionManager of [
			{},
			{ getBranch: () => "not a branch" },
			{
				getBranch: () => {
					throw new Error("unreadable");
				},
			},
		])
			assert.equal(recoverFrom(sessionManager).status, "unavailable");
	});

	it("blocks when the public branch read is unavailable", async () => {
		const { manager } = persistedSession();
		const run = routing({ manager });
		run.ctx.sessionManager = {
			getSessionId: () => manager.getSessionId(),
			getSessionFile: () => manager.getSessionFile(),
			getLeafId: () => manager.getLeafId(),
			getLeafEntry: () => manager.getLeafEntry(),
		};
		assert.deepEqual(await run.input(), CONTINUE);
		assert.equal(run.transport.calls.length, 0);
		assert.equal(
			run.coordinator.snapshotStatus().recovery?.status,
			"unavailable",
		);
		assert.match(
			formatAutoRoutingStatus(run.coordinator.snapshotStatus()),
			/could not be reconstructed/,
		);
	});

	it("keeps in-memory retained work across a reload instead of marking it unknown", async () => {
		let running = true;
		let kept: any;
		const resolved = new Set<string>();
		const retained = {
			get: () => kept,
			set: (work: any) => {
				kept = work;
			},
			resolved: {
				has: (id: string) => resolved.has(id),
				add: (id: string) => {
					resolved.add(id);
				},
			},
		};
		const before = routing({ retained, childRunning: () => running });
		assert.deepEqual(await before.input(), HANDLED);
		const reloaded = routing({
			manager: before.manager,
			retained,
			childRunning: () => running,
		});
		assert.deepEqual(reloaded.coordinator.recover(reloaded.ctx), {
			status: "clear",
		});
		// Still busy through the retained record, not through unknown work.
		assert.deepEqual(await reloaded.input("Another request."), CONTINUE);
		assert.equal(reloaded.coordinator.snapshotStatus().retained?.running, true);
		running = false;
		assert.deepEqual(await reloaded.input("A third request."), HANDLED);
		// A second reload after the child settled in this process stays clear.
		const again = routing({ manager: before.manager, retained });
		assert.deepEqual(again.coordinator.recover(again.ctx), { status: "clear" });
	});

	/**
	 * One session whose active branch is clean, plus a sibling branch holding
	 * an earlier process's accepted request with no outcome.
	 */
	function forkedSession() {
		const { manager } = persistedSession();
		const clean = manager.getLeafId()!;
		acceptedRequest(manager, ID(5));
		const unknown = manager.getLeafId()!;
		manager.branch(clean);
		return { manager, clean, unknown };
	}

	function navigate(run: ReturnType<typeof routing>, leafId: string) {
		run.coordinator.onLifecycle("session_before_tree");
		run.manager.branch(leafId);
		run.coordinator.onLifecycle("session_tree");
	}

	it("rescans the active branch after navigation: clear to unknown blocks before admission", async () => {
		const { manager, unknown } = forkedSession();
		const run = routing({ manager });
		assert.deepEqual(run.coordinator.recover(run.ctx), { status: "clear" });
		navigate(run, unknown);
		assert.deepEqual(await run.input(), CONTINUE);
		assert.equal(run.transport.calls.length, 0, "no egress");
		assert.equal(run.launches.length + run.sends.length, 0);
		const recovery = run.coordinator.snapshotStatus().recovery;
		assert.equal(recovery?.status, "unknown");
		if (recovery?.status !== "unknown") throw new Error("unreachable");
		assert.deepEqual(recovery.work, [
			{ decisionId: ID(5), evidence: "accepted" },
		]);
	});

	it("rescans the active branch after navigation: unknown to clear admits again", async () => {
		const { manager, clean, unknown } = forkedSession();
		manager.branch(unknown);
		const run = routing({ manager });
		assert.equal(run.coordinator.recover(run.ctx).status, "unknown");
		assert.deepEqual(await run.input(), CONTINUE);
		assert.equal(run.transport.calls.length, 0);
		navigate(run, clean);
		assert.deepEqual(await run.input(), HANDLED);
		assert.equal(run.launches.length, 1);
		assert.deepEqual(run.coordinator.snapshotStatus().recovery, {
			status: "clear",
		});
		// This process's own settled decision stays known across a rescan.
		run.coordinator.onLifecycle("session_before_compact");
		run.coordinator.onLifecycle("session_compact");
		assert.deepEqual(await run.input("A later request."), HANDLED);
		assert.equal(run.launches.length, 2);
		assert.deepEqual(run.coordinator.snapshotStatus().recovery, {
			status: "clear",
		});
	});

	it("rescans after a session transition in both directions", async () => {
		const unknownSession = () => {
			const { manager } = persistedSession();
			acceptedRequest(manager, ID(6));
			return manager;
		};
		// Clear to unknown.
		const toUnknown = routing();
		assert.deepEqual(toUnknown.coordinator.recover(toUnknown.ctx), {
			status: "clear",
		});
		toUnknown.coordinator.onLifecycle("session_start");
		toUnknown.ctx.sessionManager = unknownSession();
		assert.deepEqual(await toUnknown.input(), CONTINUE);
		assert.equal(toUnknown.transport.calls.length, 0);
		assert.equal(toUnknown.launches.length + toUnknown.sends.length, 0);
		assert.equal(
			toUnknown.coordinator.snapshotStatus().recovery?.status,
			"unknown",
		);

		// Unknown to clear.
		const toClear = routing({ manager: unknownSession() });
		assert.equal(toClear.coordinator.recover(toClear.ctx).status, "unknown");
		assert.deepEqual(await toClear.input(), CONTINUE);
		toClear.coordinator.onLifecycle("session_start");
		const clean = persistedSession().manager;
		toClear.ctx.sessionManager = clean;
		assert.deepEqual(await toClear.input(), HANDLED);
		assert.equal(toClear.launches.length, 1);
		assert.equal(
			clean
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === AUTO_REQUEST_CUSTOM_TYPE,
				).length,
			1,
			"recorded in the current session",
		);
	});
});

describe("input coordinator: session transitions start at before-events (F004)", () => {
	it("holds and sends no Batch B when compaction or navigation starts during A, even if it later fails", async () => {
		for (const event of [
			"session_before_compact",
			"session_before_tree",
		] as const)
			for (const mode of ROUTING_MODES) {
				const tag = `${mode} ${event}`;
				const answer = deferred<any>();
				const run = routing({
					mode,
					confirm: async () => true,
					respond: () => answer.promise,
				});
				const before = run.onDisk().length;
				const pending = run.input();
				run.coordinator.onLifecycle(event);
				// No completion event follows: the transition was delayed or failed.
				answer.resolve(evidenceResult(run.transport.calls[0].batch));
				const result = await pending;
				await run.coordinator.settled();
				assert.equal(run.transport.calls.length, 1, `${tag}: no Batch B`);
				assert.equal(run.transport.calls[0].signals[0].aborted, true, tag);
				assert.equal(run.launches.length + run.triggered().length, 0, tag);
				assert.equal(run.onDisk().length, before, `${tag}: nothing crosses`);
				assert.deepEqual(result, mode === "shadow" ? CONTINUE : HANDLED, tag);
				if (mode !== "shadow")
					assert.equal(
						run.coordinator.snapshotStatus().last?.reason,
						"session-changed",
						tag,
					);
			}
	});

	it("rechecks idle and queued state after classification before an unowned continue", async () => {
		for (const busy of ["idle", "pending"] as const) {
			const answer = deferred<any>();
			const run = routing({ respond: () => answer.promise });
			const pending = run.input();
			if (busy === "idle") run.state.idle = false;
			else run.state.pending = true;
			answer.resolve(evidenceResult(run.transport.calls[0].batch, true));
			assert.deepEqual(await pending, HANDLED, busy);
			assert.equal(run.launches.length, 0, busy);
			assert.equal(
				run.coordinator.snapshotStatus().last?.reason,
				"parent-busy",
				busy,
			);
		}
	});

	it("keeps shadow observing through parent work but not through a transition", async () => {
		const answer = deferred<any>();
		const run = routing({ mode: "shadow", respond: () => answer.promise });
		await run.input();
		run.coordinator.onLifecycle("agent_start");
		run.state.idle = false;
		run.coordinator.onLifecycle("session_before_compact");
		answer.resolve(evidenceResult(run.transport.calls[0].batch));
		await run.coordinator.settled();
		assert.equal(run.transport.calls.length, 1);
		assert.equal(run.receipts().length, 0);
	});
});

describe("input coordinator: supersession only at the ingress boundary (F005)", () => {
	it("lets only a TUI interactive non-streaming submission supersede a pending decision", async () => {
		const outside: Array<[string, string, (typeof SOURCES)[number], any]> = [
			["rpc mode", "rpc", "interactive", undefined],
			["json mode", "json", "interactive", undefined],
			["print mode", "print", "interactive", undefined],
			["rpc source", "tui", "rpc", undefined],
			["extension source", "tui", "extension", undefined],
			["steer", "tui", "interactive", "steer"],
			["followUp", "tui", "interactive", "followUp"],
		];
		for (const [label, hostMode, source, streaming] of outside) {
			const answer = deferred<any>();
			const run = routing({
				respond: (batch, index) =>
					index === 0 ? answer.promise : evidenceResult(batch),
			});
			const older = run.input();
			const other = Object.create(run.ctx, { mode: { value: hostMode } });
			assert.deepEqual(
				await run.coordinator.onInput(
					inputEvent("A second submission.", source, streaming),
					other,
				),
				CONTINUE,
				label,
			);
			assert.equal(
				run.coordinator.snapshotStatus().pending?.phase,
				"classifying",
			);
			answer.resolve(evidenceResult(run.transport.calls[0].batch));
			assert.deepEqual(await older, HANDLED, label);
			assert.equal(
				run.launches.length,
				1,
				`${label}: no effect on the decision`,
			);
			assert.equal(run.coordinator.snapshotStatus().last?.phase, "dispatched");
		}

		const boundary: Array<[string, InputArgs]> = [
			["plain", ["A second submission."]],
			["command", ["/subagent ai-reporter do it"]],
			["shell", ["!ls"]],
			["image", [TASK, "interactive", undefined, [IMAGE]]],
			["blank", ["   "]],
		];
		for (const [label, args] of boundary) {
			const answer = deferred<any>();
			const run = routing({ respond: () => answer.promise });
			const older = run.input();
			assert.deepEqual(await run.input(...args), CONTINUE, label);
			answer.resolve(evidenceResult(run.transport.calls[0].batch));
			assert.deepEqual(await older, HANDLED, label);
			assert.equal(run.launches.length, 0, label);
			assert.equal(
				run.coordinator.snapshotStatus().last?.reason,
				"superseded",
				label,
			);
		}
	});
});

describe("input coordinator: one classifier deadline through launch (F006)", () => {
	it("holds with no launch or fallback when the budget expires during recording", async () => {
		for (const failurePolicy of ["parent", "hold"] as const) {
			const time = testClock();
			const run = routing({
				failurePolicy,
				clock: time.now,
				onSend: (message) => {
					if (message.details?.state === "accepted") time.advance(5000);
				},
			});
			assert.deepEqual(await run.input(), HANDLED, failurePolicy);
			assert.equal(run.launches.length, 0, failurePolicy);
			assert.equal(run.triggered().length, 0, `${failurePolicy}: no fallback`);
			assert.equal(run.statuses()[0].details.state, "held");
			assert.equal(
				run.coordinator.snapshotStatus().last?.reason,
				"jev-timeout",
			);
		}
	});

	it("holds with no launch or fallback when the budget expires during revalidation", async () => {
		const time = testClock();
		let recorded = false;
		const durable = routingConfig("auto");
		const run = routing({
			clock: time.now,
			config: () => {
				// Local revalidation reads the config once the request is recorded.
				if (recorded) time.advance(5000);
				return durable;
			},
			onSend: (message) => {
				if (message.details?.state === "accepted") recorded = true;
			},
		});
		assert.deepEqual(await run.input(), HANDLED);
		assert.equal(run.launches.length, 0);
		assert.equal(run.triggered().length, 0, "no parent fallback");
		assert.equal(run.statuses()[0].details.state, "held");
		assert.equal(run.coordinator.snapshotStatus().last?.reason, "jev-timeout");
	});

	it("holds with jev-timeout, never a parent fallback, when revalidation both expires and fails", async () => {
		for (const failurePolicy of ["parent", "hold"] as const) {
			const time = testClock();
			let recorded = false;
			const durable = routingConfig("auto", failurePolicy);
			const drifted = routingConfig("auto", failurePolicy, "xhigh");
			const run = routing({
				failurePolicy,
				clock: time.now,
				config: () => {
					if (!recorded) return durable;
					// Revalidation spends the budget and sees drift.
					time.advance(5000);
					return drifted;
				},
				onSend: (message) => {
					if (message.details?.state === "accepted") recorded = true;
				},
			});
			assert.deepEqual(await run.input(), HANDLED, failurePolicy);
			assert.equal(run.launches.length, 0, failurePolicy);
			assert.equal(run.triggered().length, 0, `${failurePolicy}: no fallback`);
			assert.equal(run.statuses().length, 1, failurePolicy);
			assert.equal(run.statuses()[0].details.state, "held");
			assert.equal(run.statuses()[0].details.reason, "jev-timeout");
			assert.equal(
				run.coordinator.snapshotStatus().last?.reason,
				"jev-timeout",
			);
		}
	});

	it("never sends an owned parent fallback after the budget expired", async () => {
		const time = testClock();
		const run = routing({
			clock: time.now,
			launch: async () => {
				time.advance(5000);
				return { status: "rejected", detail: "prepared-run-stale" };
			},
		});
		assert.deepEqual(await run.input(), HANDLED);
		assert.equal(run.launches.length, 1);
		assert.equal(run.triggered().length, 0, "no parent fallback");
		assert.equal(run.statuses()[0].details.state, "held");
		assert.equal(run.coordinator.snapshotStatus().last?.reason, "jev-timeout");
	});

	it("triggers the parent fallback within budget, writing its receipt only after the trigger", async () => {
		const time = testClock();
		const events: Array<{ kind: string; at: number; phase?: string }> = [];
		let receiptsAtTrigger: number | undefined;
		const run: ReturnType<typeof routing> = routing({
			clock: time.now,
			launch: async () => {
				// One millisecond of budget is left when the launch is rejected.
				time.advance(4999);
				events.push({ kind: "rejected", at: time.now() });
				return { status: "rejected", detail: "prepared-run-stale" };
			},
			onAppend: (_type, data) => {
				events.push({ kind: "append", at: time.now(), phase: data.phase });
				// Every receipt write is slow.
				time.advance(2);
			},
			onSend: (_message, sendOptions) => {
				if (!sendOptions?.triggerTurn) return;
				events.push({
					kind: "trigger",
					at: time.now(),
					phase: run.coordinator.snapshotStatus().last?.phase,
				});
				receiptsAtTrigger = run.receipts().length;
			},
		});
		assert.deepEqual(await run.input(), HANDLED);
		assert.equal(run.triggered().length, 1, "one parent fallback");
		assert.deepEqual(
			events.map((event) => event.kind),
			["rejected", "trigger", "append"],
			"no receipt write between the rejection and the trigger",
		);
		const trigger = events[1];
		assert.ok(trigger.at < 5000, `triggered at ${trigger.at} ms`);
		// Terminal before the trigger, with no outcome persisted yet.
		assert.equal(trigger.phase, "fallback-attempted");
		assert.equal(receiptsAtTrigger, 0);
		assert.equal(events[2].phase, "fallback-attempted");
		const receipts = run.receipts();
		assert.equal(receipts.length, 1);
		assert.equal(receipts[0].data.phase, "fallback-attempted");
		assert.equal(receipts[0].data.reason, "launch-rejected");
	});

	it("holds when the last pre-trigger session check outlasts the budget", async () => {
		const time = testClock();
		const run: ReturnType<typeof routing> = routing({
			clock: time.now,
			launch: async () => {
				time.advance(4999);
				// Reading the session is slow from now on.
				const manager = run.ctx.sessionManager;
				const leaf = manager.getLeafId.bind(manager);
				manager.getLeafId = () => {
					time.advance(2);
					return leaf();
				};
				return { status: "rejected", detail: "prepared-run-stale" };
			},
		});
		assert.deepEqual(await run.input(), HANDLED);
		assert.equal(run.triggered().length, 0, "no parent fallback");
		assert.equal(run.statuses()[0].details.state, "held");
		assert.equal(run.statuses()[0].details.reason, "jev-timeout");
		const receipts = run.receipts();
		assert.equal(receipts.length, 1);
		assert.equal(receipts[0].data.phase, "held");
		assert.equal(receipts[0].data.reason, "jev-timeout");
	});

	it("records a failed fallback trigger as held and never resends it", async () => {
		const run = routing({
			send: "throw-trigger",
			launch: async () => ({
				status: "rejected",
				detail: "prepared-run-stale",
			}),
		});
		assert.deepEqual(await run.input(), HANDLED);
		assert.equal(run.triggered().length, 1, "attempted once, not resent");
		assert.equal(run.statuses().length, 0);
		assert.match(run.notices.join("\n"), /was not resent/);
		const last = run.coordinator.snapshotStatus().last;
		assert.equal(last?.phase, "held");
		assert.equal(last?.reason, "launch-rejected");
		const receipts = run.receipts();
		assert.equal(receipts.length, 1);
		assert.equal(receipts[0].data.phase, "held");
		assert.equal(receipts[0].data.reason, "launch-rejected");
	});

	it("treats a selection past the budget as an unowned timeout", async () => {
		for (const failurePolicy of ["parent", "hold"] as const) {
			const time = testClock();
			const run = routing({
				failurePolicy,
				clock: time.now,
				respond: (batch, index) => {
					if (index === 1) time.advance(5000);
					return evidenceResult(batch);
				},
			});
			assert.deepEqual(
				await run.input(),
				failurePolicy === "parent" ? CONTINUE : HANDLED,
			);
			assert.equal(run.launches.length, 0);
			assert.equal(
				run.coordinator.snapshotStatus().last?.reason,
				"jev-timeout",
			);
			if (failurePolicy === "parent") assert.equal(run.requests().length, 0);
		}
	});

	it("keeps the pilot's explicit dialog allowance without resetting the budget", async () => {
		// Classification spent 4 s of 5 s; the dialog took 20 s.
		const time = testClock();
		const approved = routing({
			mode: "pilot",
			clock: time.now,
			respond: (batch, index) => {
				if (index === 1) time.advance(4000);
				return evidenceResult(batch);
			},
			confirm: async () => {
				time.advance(20_000);
				return true;
			},
		});
		assert.deepEqual(await approved.input(), HANDLED);
		assert.equal(approved.launches.length, 1, "the approval is not expired");

		// The budget must be valid before the dialog opens.
		const late = testClock();
		const expired = routing({
			mode: "pilot",
			clock: late.now,
			confirm: async () => true,
			onSend: (message) => {
				if (message.details?.state === "accepted") late.advance(5000);
			},
		});
		assert.deepEqual(await expired.input(), HANDLED);
		assert.equal(expired.confirms.length, 0, "no dialog past the budget");
		assert.equal(expired.launches.length, 0);

		// Time after the dialog still spends what was left.
		const after = testClock();
		let approvedAt = false;
		const durable = routingConfig("pilot");
		const spent = routing({
			mode: "pilot",
			clock: after.now,
			config: () => {
				if (approvedAt) after.advance(5000);
				return durable;
			},
			confirm: async () => {
				approvedAt = true;
				return true;
			},
		});
		assert.deepEqual(await spent.input(), HANDLED);
		assert.equal(spent.launches.length, 0);
		assert.equal(spent.triggered().length, 0);
		assert.equal(
			spent.coordinator.snapshotStatus().last?.reason,
			"jev-timeout",
		);
	});

	it("rejects every pilot answer observed at or past 30 seconds, even a yes with a late timer", async () => {
		const answers: Array<[string, () => Promise<boolean>]> = [
			["yes", async () => true],
			["no", async () => false],
			[
				"error",
				async () => {
					throw new Error("dialog failed late");
				},
			],
		];
		for (const [label, answer] of answers)
			for (const elapsed of [AUTO_PILOT_CONFIRM_TIMEOUT_MS, 45_000]) {
				const time = testClock();
				const run = routing({
					mode: "pilot",
					clock: time.now,
					confirm: async () => {
						time.advance(elapsed);
						return answer();
					},
					// The timer callback is delayed past the answer.
					setTimer: () => () => undefined,
				});
				const name = `${label} at ${elapsed} ms`;
				assert.deepEqual(await run.input(), HANDLED, name);
				assert.equal(run.launches.length, 0, name);
				assert.equal(run.triggered().length, 0, `${name}: no fallback`);
				assert.equal(run.statuses()[0].details.state, "held", name);
				assert.equal(
					run.coordinator.snapshotStatus().last?.reason,
					"pilot-timeout",
					name,
				);
			}

		// Just inside the allowance a yes still approves, and the dialog
		// time pauses rather than spends the classifier budget.
		const time = testClock();
		const inside = routing({
			mode: "pilot",
			clock: time.now,
			confirm: async () => {
				time.advance(AUTO_PILOT_CONFIRM_TIMEOUT_MS - 1);
				return true;
			},
			setTimer: () => () => undefined,
		});
		assert.deepEqual(await inside.input(), HANDLED);
		assert.equal(inside.launches.length, 1);
	});
});

describe("expanded request view shows every admissible request (F007)", () => {
	it("shows a >400-line request under 8 KiB in full after escaping", () => {
		const id = "ad-00000000-0000-4000-8000-000000000000";
		const cases = [
			["\n".repeat(AUTO_ROUTING_REQUEST_LIMITS.maxPromptBytes - 4), "end"],
			[
				"\r\n".repeat(AUTO_ROUTING_REQUEST_LIMITS.maxPromptBytes / 2 - 2),
				"end",
			],
			[
				"\t\r".repeat(AUTO_ROUTING_REQUEST_LIMITS.maxPromptBytes / 2 - 2),
				"end",
			],
			[Array.from({ length: 1200 }, (_, i) => `l${i}`).join("\n"), "\nend"],
		];
		for (const [body, tail] of cases) {
			const request = `${body}${tail}`;
			assert.ok(
				Buffer.byteLength(request) <=
					AUTO_ROUTING_REQUEST_LIMITS.maxPromptBytes,
			);
			assert.ok(screenAutoRoutingText(request).ok, "admissible");
			const content = formatAutoRequestContent(id, request, "accepted");
			const view = autoRequestView(
				{ content, details: { decisionId: id, state: "accepted" } },
				true,
			);
			const shown = escapeTerminalText(request).split("\n");
			assert.ok(
				shown.length > 400 || escapeTerminalText(request).length > 32 * 1024,
			);
			assert.equal(view.omitted, 0);
			assert.deepEqual(view.lines.slice(0, shown.length), shown);
			assert.ok(view.lines[shown.length - 1].endsWith("end"));
			// A parent fallback notice carrying the same request is complete too.
			const fallback = autoStatusView(
				{
					content: `Automatic delegation fell back to the parent (decision ${id}, reason: launch-rejected). No subagent was launched. Handle this request normally, or ask the user to clarify as needed:\n\n----- BEGIN REQUEST ${id} -----\n${request}\n----- END REQUEST ${id} -----`,
					details: { decisionId: id, state: "fallback-parent" },
				},
				true,
			);
			assert.equal(fallback.omitted, 0);
		}
	});
});

// Registers a second extension instance; keep this block last in the file.
describe("extension registration", () => {
	it("wires input, lifecycle, renderers, and a local-only routing command", async () => {
		const handlers = new Map<string, Function[]>();
		const commands = new Map<string, any>();
		const renderers = new Map<string, any>();
		const fake: any = {
			...flow.createApi([]),
			on(event: string, handler: Function) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			registerMessageRenderer(name: string, renderer: any) {
				renderers.set(name, renderer);
			},
		};
		const transport = fakeTransport();
		extensionModule.default(fake, {
			autoRouting: {
				loadConfig: () => ({
					status: "off",
					source: "x",
					origin: "missing-file",
					config: { version: 1, mode: "off" },
					digest: "d",
				}),
				transport: () => transport.transport,
			},
		});
		try {
			for (const event of [
				"input",
				"agent_start",
				"session_before_tree",
				"session_tree",
				"session_before_compact",
				"session_compact",
			])
				assert.equal(handlers.get(event)?.length, 1, event);
			// Invalidation never cancels the host's own transition.
			for (const event of ["session_before_tree", "session_before_compact"])
				assert.equal(
					await handlers.get(event)![0]({ type: event }, {}),
					undefined,
				);
			const run = routing();
			assert.deepEqual(
				await handlers.get("input")![0](inputEvent(TASK), run.ctx),
				CONTINUE,
			);
			assert.equal(transport.calls.length, 0, "off makes no call");

			const notices: string[] = [];
			const commandCtx = {
				ui: { notify: (text: string) => notices.push(text) },
			};
			const command = commands.get("subagents-routing");
			assert.match(command.description, /cannot enable routing/);
			await command.handler("status", commandCtx);
			await command.handler("cancel", commandCtx);
			await command.handler("enable", commandCtx);
			assert.match(notices[0], /Automatic routing: off/);
			assert.equal(notices[1], "No automatic routing decision is pending.");
			assert.match(notices[2], /Usage/);
			assert.equal(
				existsSync(
					join(process.env.PI_CODING_AGENT_DIR!, "herdr-agents", "config.json"),
				),
				false,
				"no command writes routing configuration",
			);

			const theme = {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			};
			const rendered = renderers
				.get(AUTO_REQUEST_CUSTOM_TYPE)(
					{
						content: formatAutoRequestContent("ad-1", TASK, "accepted"),
						details: { decisionId: "ad-1", state: "accepted" },
					},
					{ expanded: true, outputPad: 0 },
					theme,
				)
				.render(120)
				.join("\n");
			assert.match(
				rendered,
				/User request · automatic delegation · handler-visible text/,
			);
			assert.ok(rendered.includes(TASK));
			assert.ok(renderers.has(AUTO_STATUS_CUSTOM_TYPE));
		} finally {
			// Restore the shared harness API as the completion target.
			extensionModule.default(flow.api);
		}
	});

	it("recovers durable unknown work at session_start and reports the loaded snapshot", async () => {
		const handlers = new Map<string, Function[]>();
		const commands = new Map<string, any>();
		const fake: any = {
			...flow.createApi([]),
			on(event: string, handler: Function) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			registerMessageRenderer() {},
		};
		// An earlier process recorded an accepted request, then crashed.
		const { manager } = persistedSession();
		const decisionId = "ad-00000009-0000-4000-8000-000000000000";
		manager.appendCustomMessageEntry(
			AUTO_REQUEST_CUSTOM_TYPE,
			formatAutoRequestContent(decisionId, TASK, "accepted"),
			true,
			{ version: 1, decisionId, source: "interactive", state: "accepted" },
		);
		let durable: any = routingConfig("auto");
		const transport = fakeTransport();
		extensionModule.default(fake, {
			autoRouting: {
				loadConfig: () => durable,
				herdrAvailable: () => true,
				transport: () => transport.transport,
			},
		});
		try {
			const run = routing({ manager });
			const statuses: Array<[string, string | undefined]> = [];
			const notices: string[] = [];
			run.ctx.ui.setStatus = (key: string, text: string | undefined) =>
				statuses.push([key, text]);
			run.ctx.ui.notify = (text: string) => notices.push(text);
			// The durable file changes after load; the load's snapshot stays.
			durable = OFF_CONFIG;
			for (const handler of handlers.get("session_start") ?? [])
				await handler({ type: "session_start", reason: "startup" }, run.ctx);
			assert.deepEqual(
				statuses.find(([key]) => key === "subagents-routing"),
				["subagents-routing", "auto-route: auto"],
			);
			assert.ok(notices.some((text) => /cannot account for/.test(text)));
			durable = routingConfig("auto");
			assert.deepEqual(
				await handlers.get("input")![0](inputEvent(TASK), run.ctx),
				CONTINUE,
			);
			assert.equal(transport.calls.length, 0, "unknown work blocks egress");
			const shown: string[] = [];
			await commands.get("subagents-routing").handler("status", {
				ui: { notify: (text: string) => shown.push(text) },
			});
			assert.match(shown[0], /Automatic routing: auto/);
			assert.match(shown[0], new RegExp(`Unknown: decision ${decisionId}`));
		} finally {
			extensionModule.default(flow.api);
		}
	});
});

// ── Launch boundary guards and the run binding (T08) ───────────────────

/**
 * A fake Herdr Pi seam for the real launch handoff, installed after
 * routing(): readiness, dispatch, and settlement are scripted, and every
 * pane, readiness wait, dispatch, and close is recorded.
 */
function useAutoPiSeam(
	options: {
		ready?: () => Promise<void>;
		run?: () => void;
		watch?: (child: any) => Promise<any>;
	} = {},
) {
	const events: string[] = [];
	const closed: string[] = [];
	const commands: string[] = [];
	flow.testApi.setNativeTestSeam({
		operations: {
			createPane() {
				events.push("create");
				return "auto-pi-pane";
			},
			createWorktree() {
				throw new Error("unexpected worktree creation");
			},
			async waitForShellReady() {
				events.push("ready");
				await options.ready?.();
			},
			runScript(_surface: string, command: string, script: any) {
				events.push("run");
				commands.push(command);
				options.run?.();
				return script.scriptPath;
			},
			closePane(surface: string) {
				closed.push(surface);
			},
		},
		terminalAvailable: true,
		piWatch:
			options.watch ??
			(async (child: any) => ({
				name: child.name,
				task: child.task,
				summary: "Pi fixture result",
				exitCode: 0,
				elapsed: 0,
				sessionFile: child.sessionFile,
			})),
	});
	return { events, closed, commands };
}

/** Poll until `check` holds. */
async function until(check: () => boolean, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((resolveWait) => setTimeout(resolveWait, 5));
	}
}

/** A retained store shared across coordinator reloads, recording writes. */
function sharedRetained() {
	let kept: any;
	const writes: any[] = [];
	const resolved = new Set<string>();
	return {
		writes,
		resolvedIds: resolved,
		get: () => kept,
		set: (work: any) => {
			writes.push(work);
			kept = work;
		},
		resolved: {
			has: (id: string) => resolved.has(id),
			add: (id: string) => {
				resolved.add(id);
			},
		},
	};
}

const realLaunch = (handoff: AutoLaunchHandoff<any, any>) =>
	flow.testApi.launchAutoRoutedRun(flow.api, handoff);

describe("input coordinator: launch boundary guards (T08)", () => {
	it("creates no pane for a stale snapshot and may then take the parent policy", async () => {
		let drift = false;
		let seam!: ReturnType<typeof useAutoPiSeam>;
		const run = routing({
			config: () =>
				drift
					? routingConfig("auto", "parent", "medium")
					: routingConfig("auto"),
			launch: (handoff) => {
				drift = true;
				return realLaunch(handoff);
			},
		});
		seam = useAutoPiSeam();
		assert.deepEqual(await run.input(), HANDLED);
		assert.deepEqual(seam.events, [], "no pane, workspace, or dispatch");
		// Positively no process: the one explicit parent fallback is allowed.
		assert.equal(run.triggered().length, 1);
		assert.equal(run.triggered()[0].message.details.reason, "stale-snapshot");
		assert.equal(run.coordinator.snapshotStatus().retained, undefined);
	});

	it("never dispatches when the persisted request no longer matches", async () => {
		let seam!: ReturnType<typeof useAutoPiSeam>;
		const run = routing({
			launch: (handoff) => {
				// The recorded bytes change on disk after revalidation.
				const file = run.manager.getSessionFile()!;
				const text = readFileSync(file, "utf8");
				const altered = text.replace("BEGIN REQUEST", "BEGIN REQUESX");
				assert.notEqual(altered, text);
				writeFileSync(file, altered);
				return realLaunch(handoff);
			},
		});
		seam = useAutoPiSeam();
		assert.deepEqual(await run.input(), HANDLED);
		assert.deepEqual(seam.events, []);
		assert.equal(run.triggered().length, 0, "never a parent fallback");
		assert.equal(run.coordinator.snapshotStatus().last?.phase, "held");
		assert.equal(
			run.coordinator.snapshotStatus().last?.reason,
			"request-record-failed",
		);
	});

	it("dispatches nothing and closes only its pane when cancelled during the shell wait", async () => {
		const run = routing({ launch: realLaunch });
		const seam = useAutoPiSeam({ ready: () => new Promise<void>(() => {}) });
		const pending = run.input();
		await until(() => seam.events.includes("ready"));
		const report = run.coordinator.cancel();
		assert.equal(report.cancelled, true, report.message);
		assert.deepEqual(await pending, HANDLED);
		assert.deepEqual(seam.events, ["create", "ready"]);
		assert.deepEqual(seam.closed, ["auto-pi-pane"]);
		assert.equal(run.triggered().length, 0);
		const status = run.coordinator.snapshotStatus();
		assert.equal(status.last?.phase, "held");
		assert.equal(status.last?.reason, "user-cancelled");
		assert.equal(status.retained, undefined);
	});

	it("holds with no process when the parent starts during the shell wait", async () => {
		const run = routing({ launch: realLaunch });
		const seam = useAutoPiSeam({ ready: () => new Promise<void>(() => {}) });
		const pending = run.input();
		await until(() => seam.events.includes("ready"));
		run.coordinator.onLifecycle("agent_start");
		assert.deepEqual(await pending, HANDLED);
		assert.equal(seam.events.includes("run"), false);
		assert.deepEqual(seam.closed, ["auto-pi-pane"]);
		assert.equal(
			run.coordinator.snapshotStatus().last?.reason,
			"parent-started",
		);
		assert.equal(run.triggered().length, 0);
	});

	it("rechecks after readiness: drift during the wait dispatches nothing", async () => {
		let drift = false;
		const ready = deferred<void>();
		const run = routing({
			config: () =>
				drift
					? routingConfig("auto", "parent", "medium")
					: routingConfig("auto"),
			launch: realLaunch,
		});
		const seam = useAutoPiSeam({ ready: () => ready.promise });
		const pending = run.input();
		await until(() => seam.events.includes("ready"));
		drift = true;
		ready.resolve();
		assert.deepEqual(await pending, HANDLED);
		assert.deepEqual(seam.events, ["create", "ready"]);
		assert.deepEqual(seam.closed, ["auto-pi-pane"]);
		// Never dispatched: the stale route may take the parent policy.
		assert.equal(run.triggered().length, 1);
		assert.equal(run.triggered()[0].message.details.reason, "stale-snapshot");
	});

	it("treats a runScript throw after the latch as uncertain, never a fallback or retry", async () => {
		const run = routing({ launch: realLaunch });
		const seam = useAutoPiSeam({
			run: () => {
				throw new Error("acknowledgement lost after sending");
			},
		});
		assert.deepEqual(await run.input(), HANDLED);
		assert.equal(seam.events.filter((event) => event === "run").length, 1);
		assert.deepEqual(seam.closed, [], "a possibly running pane is kept");
		assert.equal(run.triggered().length, 0, "never parent replay");
		assert.equal(run.statuses().at(-1)?.details.state, "uncertain");
		assert.equal(run.coordinator.snapshotStatus().retained?.state, "uncertain");
		// Busy and unknown: later prompts bypass without egress or launch.
		const calls = run.transport.calls.length;
		assert.deepEqual(await run.input("Another request."), CONTINUE);
		assert.equal(run.transport.calls.length, calls);
		assert.equal(seam.events.filter((event) => event === "run").length, 1);
	});

	it("advances the binding monotonically and dispatches at most once", async () => {
		const retained = sharedRetained();
		const states: string[] = [];
		let report: { cancelled: boolean; message: string } | undefined;
		let retainedWhileRunning: unknown;
		let settledAfter = false;
		let decisionId = "";
		let run!: ReturnType<typeof routing>;
		run = routing({
			retained,
			launch: async (handoff) => {
				const binding = handoff.binding;
				decisionId = binding.receipt.decisionId;
				states.push(binding.dispatchState());
				binding.beforeResources();
				binding.resourcesCreated();
				states.push(binding.dispatchState());
				binding.commitDispatch();
				states.push(binding.dispatchState());
				// Nothing moves the latch back or dispatches again.
				binding.resourcesCreated();
				states.push(binding.dispatchState());
				assert.throws(() => binding.beforeResources(), /already began/);
				assert.throws(() => binding.commitDispatch(), /one dispatch/);
				// Past the latch, cancel and a parent start stop nothing.
				report = run.coordinator.cancel();
				run.coordinator.onLifecycle("agent_start");
				binding.recordStarted("child-x");
				binding.recordStarted("child-y");
				states.push(binding.dispatchState());
				assert.throws(() => binding.commitDispatch(), /one dispatch/);
				retainedWhileRunning = retained.get();
				binding.recordSettled();
				binding.recordSettled();
				settledAfter = binding.settled();
				return { status: "started", childId: "child-x", name: "auto" };
			},
		});
		assert.deepEqual(await run.input(), HANDLED);
		assert.deepEqual(states, [
			"uncommitted",
			"resources-created",
			"dispatch-attempted",
			"dispatch-attempted",
			"started",
		]);
		assert.equal(report?.cancelled, false);
		assert.match(report?.message ?? "", /already attempted its dispatch/);
		assert.deepEqual(retainedWhileRunning, {
			decisionId,
			state: "dispatched",
			childId: "child-x",
			bound: true,
		});
		assert.equal(settledAfter, true);
		// Settled once; the fast child is never retained again afterwards.
		assert.deepEqual(retained.writes.at(-1), undefined);
		assert.equal(retained.writes.length, 2);
		assert.equal(retained.get(), undefined);
		const [started] = run.statuses();
		assert.equal(started.details.state, "started");
		assert.match(started.content, /already finished/);
		assert.equal(run.coordinator.snapshotStatus().last?.phase, "dispatched");
	});
});

describe("input coordinator: run lifecycle and provenance (T08)", () => {
	const decisionOf = (run: ReturnType<typeof routing>) =>
		run.statuses()[0].details.decisionId;
	const expectedReceipt = (run: ReturnType<typeof routing>) => {
		const [started] = run.statuses();
		const snapshotConfig = routingConfig("auto");
		return {
			decisionId: started.details.decisionId,
			policyVersion: "jev-auto-v1",
			questionVersion: "jev-auto-questions-v1",
			jevModel: "jev-1.13.0",
			candidateId: started.details.candidateId,
			configHash: snapshotConfig.digest,
			candidateSetHash: run.launches[0].binding.receipt.candidateSetHash,
			selectionSource: "auto",
		};
	};

	it("records the start before an instant result, settles once, and carries the receipt", async () => {
		const retained = sharedRetained();
		const run = routing({ retained, launch: realLaunch });
		let atWatch: any;
		const seam = useAutoPiSeam({
			watch: async (child: any) => {
				atWatch = retained.get();
				return {
					name: child.name,
					task: child.task,
					summary: "Pi fixture result",
					exitCode: 0,
					elapsed: 0,
					sessionFile: child.sessionFile,
				};
			},
		});
		assert.deepEqual(await run.input(), HANDLED);
		const id = decisionOf(run);
		const result = await flow.waitForMessage(
			(message) =>
				message.customType === "subagent_result" &&
				message.details?.autoRouting?.decisionId === id,
		);
		const receipt = expectedReceipt(run);
		assert.deepEqual(result.details.autoRouting, receipt);
		assert.match(receipt.candidateSetHash, /^[0-9a-f]{64}$/);
		assert.equal(result.details.selection.harnessSource, "auto");
		await until(() => retained.get() === undefined);
		// Bound before the watcher, released once on known settlement.
		assert.equal(atWatch?.bound, true, "recorded started before the watcher");
		assert.equal(retained.writes[0].bound, true);
		assert.equal(retained.writes[0].state, "dispatched");
		assert.equal(retained.writes.length, 2);
		assert.ok(retained.resolvedIds.has(id));
		// The instant result's parent turn never cancelled the decision.
		assert.equal(run.coordinator.snapshotStatus().last?.phase, "dispatched");
		assert.match(
			seam.commands[0],
			/&& unset TYPESAFE_API_KEY && export PI_HERDR_AUTO_ROUTING_DISABLED=1 && /,
		);
		// The slot is free again: the next prompt routes.
		assert.deepEqual(await run.input("A second request."), HANDLED);
		assert.equal(run.launches.length, 2);
	});

	it("carries the receipt on watcher errors and help requests and settles each", async () => {
		for (const outcome of ["error", "help"] as const) {
			const retained = sharedRetained();
			const run = routing({ retained, launch: realLaunch });
			useAutoPiSeam({
				watch: async (child: any) => {
					if (outcome === "error") throw new Error("watch failed");
					return {
						name: child.name,
						task: child.task,
						summary: "needs help",
						exitCode: 0,
						elapsed: 0,
						sessionFile: child.sessionFile,
						ping: { name: child.name, message: "Which module?" },
					};
				},
			});
			assert.deepEqual(await run.input(), HANDLED);
			const id = decisionOf(run);
			const delivered = await flow.waitForMessage(
				(message) =>
					message.customType ===
						(outcome === "error" ? "subagent_result" : "subagent_ping") &&
					message.details?.autoRouting?.decisionId === id,
			);
			assert.deepEqual(delivered.details.autoRouting, expectedReceipt(run));
			assert.equal(delivered.details.selection.harnessSource, "auto");
			assert.equal(delivered.details.runtimeProvenance.model.source, "auto");
			if (outcome === "error")
				assert.equal(delivered.details.error, "watch failed");
			await until(() => retained.get() === undefined);
			assert.equal(retained.writes.length, 2, outcome);
		}
	});

	it("keeps a bound child busy across a reload until its known settlement", async () => {
		const retained = sharedRetained();
		const settle = deferred<void>();
		const before = routing({ retained, launch: realLaunch });
		useAutoPiSeam({
			watch: async (child: any) => {
				await settle.promise;
				return {
					name: child.name,
					task: child.task,
					summary: "done",
					exitCode: 0,
					elapsed: 0,
					sessionFile: child.sessionFile,
				};
			},
		});
		assert.deepEqual(await before.input(), HANDLED);
		const id = decisionOf(before);
		// A reloaded coordinator that cannot see the child in its map.
		const reloaded = routing({
			manager: before.manager,
			retained,
			childRunning: () => false,
			launch: realLaunch,
		});
		assert.deepEqual(reloaded.coordinator.recover(reloaded.ctx), {
			status: "clear",
		});
		assert.deepEqual(await reloaded.input("Another request."), CONTINUE);
		assert.equal(reloaded.transport.calls.length, 0, "busy: no egress");
		assert.equal(
			reloaded.coordinator.snapshotStatus().retained?.decisionId,
			id,
		);
		settle.resolve();
		await until(() => retained.get() === undefined);
		assert.ok(retained.resolvedIds.has(id));
		assert.deepEqual(await reloaded.input("A third request."), HANDLED);
		assert.equal(reloaded.launches.length, 1);
	});
});

describe("input coordinator: a binding authorizes only its own handle (T08R-F001)", () => {
	it("rejects every other handle, a copied binding, and an unbound tuple, then launches its own", async () => {
		const attempts: Array<{ label: string; error: string }> = [];
		const run = routing({
			launch: async (handoff) => {
				const own = handoff.candidate.prepared;
				const ctx = handoff.ctx;
				const other = () => {
					const preparation = flow.testApi.prepareSubagentRun(
						flow.api,
						{ ...own.params },
						ctx,
						{ auto: own.auto },
					);
					assert.ok(preparation.ok, JSON.stringify(preparation));
					return preparation.prepared;
				};
				const tries: Array<[string, any, any]> = [
					["another pending handle", other(), handoff.binding],
					["a copied binding", own, { ...handoff.binding }],
					["a prototype binding", own, Object.create(handoff.binding)],
					["no binding", other(), undefined],
				];
				for (const [label, prepared, autoRun] of tries) {
					const result = await flow.testApi.startSubagentRun(
						flow.api,
						prepared.params,
						ctx,
						{ prepared, autoRun },
					);
					attempts.push({ label, error: String(result.details?.error) });
				}
				return realLaunch(handoff);
			},
		});
		const seam = useAutoPiSeam();
		assert.deepEqual(await run.input(), HANDLED);
		assert.deepEqual(attempts, [
			{ label: "another pending handle", error: "auto-binding-invalid" },
			{ label: "a copied binding", error: "auto-binding-invalid" },
			{ label: "a prototype binding", error: "auto-binding-invalid" },
			{ label: "no binding", error: "auto-binding-required" },
		]);
		// Only the coordinator's own handoff created a pane and dispatched.
		assert.deepEqual(seam.events, ["create", "ready", "run"]);
		assert.equal(run.statuses()[0].details.state, "started");
	});
});

describe("input coordinator: request identity at launch (T08R-F001)", () => {
	it("rejects a copied request even with the genuine handle and binding", async () => {
		let error: unknown;
		const run = routing({
			launch: async (handoff) => {
				const prepared = handoff.candidate.prepared;
				const result = await flow.testApi.startSubagentRun(
					flow.api,
					{ ...prepared.params, task: "A different request" },
					handoff.ctx,
					{ prepared, autoRun: handoff.binding },
				);
				error = result.details?.error;
				return { status: "rejected", detail: "wrong request" };
			},
			failurePolicy: "hold",
		});
		const seam = useAutoPiSeam();
		assert.deepEqual(await run.input(), HANDLED);
		assert.equal(error, "prepared-run-invalid");
		assert.deepEqual(seam.events, []);
		assert.equal(run.triggered().length, 0);
	});
});

describe("input coordinator: the classifier deadline at launch (T08R-F003)", () => {
	/**
	 * An authority whose snapshot context read runs `onRead` once armed, so
	 * a launch guard's own full revalidation can spend the budget.
	 */
	function armedAuthority(onRead: () => void) {
		const state = { armed: false };
		return {
			state,
			wrap: (authority: any) => ({
				...authority,
				context: () => {
					const context = authority.context();
					if (state.armed) {
						state.armed = false;
						onRead();
					}
					return context;
				},
			}),
		};
	}

	for (const boundary of ["before resources", "before dispatch"] as const)
		it(`holds as jev-timeout when revalidation spends the budget ${boundary}`, async () => {
			let now = 0;
			const armed = armedAuthority(() => {
				now += 6_000;
			});
			const run = routing({
				clock: () => now,
				authority: armed.wrap,
				launch: (handoff) => {
					if (boundary === "before resources") armed.state.armed = true;
					return realLaunch(handoff);
				},
			});
			const seam = useAutoPiSeam({
				ready: async () => {
					if (boundary === "before dispatch") armed.state.armed = true;
				},
			});
			assert.deepEqual(await run.input(), HANDLED);
			assert.equal(seam.events.includes("run"), false, "never dispatched");
			assert.deepEqual(
				seam.events,
				boundary === "before resources" ? [] : ["create", "ready"],
			);
			assert.deepEqual(
				seam.closed,
				boundary === "before resources" ? [] : ["auto-pi-pane"],
			);
			// Owned: the expired budget holds, never a parent fallback.
			assert.equal(run.triggered().length, 0);
			const status = run.coordinator.snapshotStatus();
			assert.equal(status.last?.phase, "held");
			assert.equal(status.last?.reason, "jev-timeout");
			assert.equal(status.retained, undefined);
		});
});

describe("input coordinator: native prerequisite deadlines (T08R-F003)", () => {
	for (const boundary of ["before resources", "before dispatch"] as const)
		for (const unavailable of [false, true])
			it(`holds if native prerequisite revalidation expires ${boundary}, available=${!unavailable}`, async () => {
				let now = 0;
				let armed = false;
				const run = routing({
					clock: () => now,
					config: () =>
						routingConfig("auto", "parent", "high", {
							harness: "claude",
							id: "claude-dest-4",
						}),
					authority: (authority: any) => ({
						...authority,
						nativeOperations: () => {
							const operations = authority.nativeOperations();
							return {
								...operations,
								assertAvailable(harness: any) {
									operations.assertAvailable(harness);
									if (armed) {
										armed = false;
										now += 6_000;
										if (unavailable) throw new Error("Prerequisite lost");
									}
								},
							};
						},
					}),
					launch: (handoff) => {
						if (boundary === "before resources") armed = true;
						return realLaunch(handoff);
					},
				});
				const seam = useAutoPiSeam({
					ready: async () => {
						if (boundary === "before dispatch") armed = true;
					},
				});
				assert.deepEqual(await run.input(), HANDLED);
				assert.equal(armed, false, "native prerequisites were revalidated");
				assert.deepEqual(
					seam.events,
					boundary === "before resources" ? [] : ["create", "ready"],
				);
				assert.equal(run.triggered().length, 0);
				assert.equal(
					run.coordinator.snapshotStatus().last?.reason,
					"jev-timeout",
				);
				assert.equal(run.coordinator.snapshotStatus().retained, undefined);
			});
});

describe("input coordinator: cancellation from inside final revalidation (T08R-F004)", () => {
	for (const via of ["cancel", "session transition"] as const)
		it(`never dispatches after a ${via} during the commit guard's revalidation`, async () => {
			let armed = false;
			let report: { cancelled: boolean; message: string } | undefined;
			let run!: ReturnType<typeof routing>;
			run = routing({
				// The final revalidation returns otherwise valid data; only the
				// callback itself cancels or changes the session.
				authority: (authority: any) => ({
					...authority,
					context: () => {
						const context = authority.context();
						if (armed) {
							armed = false;
							if (via === "cancel") report = run.coordinator.cancel();
							else run.coordinator.onLifecycle("session_before_tree");
						}
						return context;
					},
				}),
				launch: realLaunch,
			});
			const seam = useAutoPiSeam({
				ready: async () => {
					armed = true;
				},
			});
			assert.deepEqual(await run.input(), HANDLED);
			if (via === "cancel") assert.equal(report?.cancelled, true);
			assert.equal(armed, false, "the commit guard revalidated");
			assert.deepEqual(seam.events, ["create", "ready"]);
			assert.deepEqual(seam.closed, ["auto-pi-pane"]);
			assert.equal(run.triggered().length, 0, "never a parent fallback");
			const status = run.coordinator.snapshotStatus();
			assert.equal(status.last?.phase, "held");
			assert.equal(
				status.last?.reason,
				via === "cancel" ? "user-cancelled" : "session-changed",
			);
			assert.equal(status.retained, undefined);
		});
});

describe("input coordinator: final config callback changes (T08R-F004)", () => {
	for (const change of ["cwd", "session", "idle", "pending", "cancel"] as const)
		it(`blocks ${change} changes made inside the last config read`, async () => {
			let reads: number | undefined;
			let cancelled: boolean | undefined;
			let run!: ReturnType<typeof routing>;
			run = routing({
				config: () => {
					if (reads !== undefined && ++reads === 3) {
						if (change === "cwd") run.ctx.cwd = tmpdir();
						if (change === "session")
							run.ctx.sessionManager = persistedSession().manager;
						if (change === "idle") run.state.idle = false;
						if (change === "pending") run.state.pending = true;
						if (change === "cancel")
							cancelled = run.coordinator.cancel().cancelled;
					}
					return routingConfig("auto");
				},
				launch: realLaunch,
			});
			const seam = useAutoPiSeam({
				ready: async () => {
					reads = 0;
				},
			});
			assert.deepEqual(await run.input(), HANDLED);
			assert.ok((reads ?? 0) >= 3, "the final config callback ran");
			if (change === "cancel") assert.equal(cancelled, true);
			assert.deepEqual(seam.events, ["create", "ready"]);
			assert.deepEqual(seam.closed, ["auto-pi-pane"]);
			assert.equal(run.triggered().length, 0);
			assert.equal(run.coordinator.snapshotStatus().last?.phase, "held");
			assert.equal(run.coordinator.snapshotStatus().retained, undefined);
		});
});

describe("input coordinator: terminal observation ordering (T08R-F004)", () => {
	for (const change of ["idle", "pending"] as const)
		it(`holds when loader read 6 changes ${change} but returns unchanged config`, async () => {
			let reads: number | undefined;
			let run!: ReturnType<typeof routing>;
			run = routing({
				config: () => {
					if (reads !== undefined && ++reads === 6) {
						if (change === "idle") run.state.idle = false;
						else run.state.pending = true;
					}
					return routingConfig("auto");
				},
				launch: realLaunch,
			});
			const seam = useAutoPiSeam({
				ready: async () => {
					reads = 0;
				},
			});
			assert.deepEqual(await run.input(), HANDLED);
			assert.equal(reads, 6, "the actual last loader read ran");
			assert.deepEqual(seam.events, ["create", "ready"], "no runScript");
			assert.deepEqual(seam.closed, ["auto-pi-pane"]);
			assert.equal(run.triggered().length, 0, "no parent fallback");
			assert.equal(run.coordinator.snapshotStatus().last?.phase, "held");
			assert.equal(
				run.coordinator.snapshotStatus().last?.reason,
				"parent-started",
			);
			assert.equal(run.coordinator.snapshotStatus().retained, undefined);
		});

	for (const clockRead of [1, 2])
		for (const change of ["idle", "pending"] as const)
			it(`observes ${change} changes in terminal injected clock read ${clockRead}`, async () => {
				let reads: number | undefined;
				let clocks = 0;
				let mutated = false;
				let run!: ReturnType<typeof routing>;
				run = routing({
					config: () => {
						if (reads !== undefined) ++reads;
						return routingConfig("auto");
					},
					clock: () => {
						// Read 1 is the terminal expired check, read 2 the final
						// remaining allowance. Both must precede observing busy.
						if (reads === 6 && ++clocks === clockRead) {
							mutated = true;
							if (change === "idle") run.state.idle = false;
							else run.state.pending = true;
						}
						return 0;
					},
					launch: realLaunch,
				});
				const seam = useAutoPiSeam({
					ready: async () => {
						reads = 0;
					},
				});
				assert.deepEqual(await run.input(), HANDLED);
				assert.equal(mutated, true);
				assert.deepEqual(seam.events, ["create", "ready"]);
				assert.deepEqual(seam.closed, ["auto-pi-pane"]);
				assert.equal(run.triggered().length, 0);
				assert.equal(run.coordinator.snapshotStatus().last?.phase, "held");
				assert.equal(
					run.coordinator.snapshotStatus().last?.reason,
					"parent-started",
				);
				assert.equal(run.coordinator.snapshotStatus().retained, undefined);
			});

	it("runs no loader, authority, or injected clock after terminal pending/idle until dispatch", async () => {
		let armed = false;
		const trace: string[] = [];
		let atDispatch: string[] = [];
		const run = routing({
			config: () => {
				if (armed) trace.push("loader");
				return routingConfig("auto");
			},
			clock: () => {
				if (armed) trace.push("clock");
				return 0;
			},
			authority: (authority: any) => ({
				...authority,
				context: () => {
					if (armed) trace.push("authority");
					return authority.context();
				},
			}),
			launch: realLaunch,
		});
		useAutoPiSeam({
			ready: async () => {
				armed = true;
				run.ctx.hasPendingMessages = () => {
					trace.push("pending");
					return false;
				};
				run.ctx.isIdle = () => {
					trace.push("idle");
					return true;
				};
			},
			run: () => {
				trace.push("run");
				atDispatch = [...trace];
				armed = false;
			},
		});
		assert.deepEqual(await run.input(), HANDLED);
		assert.equal(atDispatch.filter((event) => event === "loader").length, 6);
		assert.equal(atDispatch.filter((event) => event === "pending").length, 4);
		assert.ok(atDispatch.includes("authority"));
		assert.deepEqual(atDispatch.slice(atDispatch.lastIndexOf("pending")), [
			"pending",
			"idle",
			"run",
		]);
	});
});

describe("input coordinator: final pending callback mutations (T08R-F004)", () => {
	for (const change of [
		"cwd",
		"session",
		"config revoked",
		"config changed",
		"branch",
		"request",
		"idle",
		"cancel",
		"generation",
		"deadline",
	] as const)
		it(`holds without dispatch or fallback after final pending changes ${change}`, async () => {
			let config: LoadedAutoRoutingConfig = routingConfig("auto");
			let now = 0;
			let reads = 0;
			const run = routing({
				config: () => config,
				clock: () => now,
				launch: realLaunch,
			});
			const seam = useAutoPiSeam({
				ready: async () => {
					// One initial observation, then the two bounded coherence
					// observations. Mutate on the LAST pending callback only.
					run.ctx.hasPendingMessages = () => {
						if (++reads === 3) {
							if (change === "cwd") run.ctx.cwd = tmpdir();
							if (change === "session")
								run.ctx.sessionManager = persistedSession().manager;
							if (change === "config revoked")
								config = {
									status: "off",
									source: "test.json",
									origin: "missing-section",
									config: { version: 1, mode: "off" },
									digest: "revoked",
								};
							if (change === "config changed")
								config = routingConfig("auto", "parent", "medium");
							if (change === "branch")
								run.manager.appendCustomEntry("unrelated", {});
							if (change === "request") {
								const file = run.manager.getSessionFile()!;
								writeFileSync(
									file,
									readFileSync(file, "utf8").replace(
										"BEGIN REQUEST",
										"BEGIN REQUESX",
									),
								);
							}
							if (change === "idle") run.state.idle = false;
							if (change === "cancel") run.coordinator.cancel();
							if (change === "generation")
								run.coordinator.onLifecycle("session_before_tree");
							if (change === "deadline") now += 6_000;
						}
						return false;
					};
				},
			});
			assert.deepEqual(await run.input(), HANDLED);
			assert.equal(reads >= 3, true, "the final pending callback ran");
			assert.deepEqual(seam.events, ["create", "ready"]);
			assert.deepEqual(seam.closed, ["auto-pi-pane"]);
			assert.equal(run.triggered().length, 0, "zero parent fallback");
			assert.equal(run.coordinator.snapshotStatus().last?.phase, "held");
			assert.equal(run.coordinator.snapshotStatus().retained, undefined);
		});

	it("observes current-host accessor-backed cwd/session after the final pending callback", async () => {
		const run = routing({ launch: realLaunch });
		let cwd = run.ctx.cwd;
		let manager = run.ctx.sessionManager;
		Object.defineProperties(run.ctx, {
			cwd: { configurable: true, get: () => cwd },
			sessionManager: { configurable: true, get: () => manager },
		});
		let reads = 0;
		const seam = useAutoPiSeam({
			ready: async () => {
				run.ctx.hasPendingMessages = () => {
					if (++reads === 3) {
						cwd = tmpdir();
						manager = persistedSession().manager;
					}
					return false;
				};
			},
		});
		assert.deepEqual(await run.input(), HANDLED);
		assert.ok(reads >= 3);
		assert.deepEqual(seam.events, ["create", "ready"]);
		assert.deepEqual(seam.closed, ["auto-pi-pane"]);
		assert.equal(run.triggered().length, 0);
		assert.equal(run.coordinator.snapshotStatus().last?.phase, "held");
	});
});

describe("input coordinator: terminal pending mutation fences (T08R-F004)", () => {
	for (const [change, reason] of [
		["cwd", "session-changed"],
		["session", "session-changed"],
		["config revoked", "internal-error"],
		["config changed", "internal-error"],
		["branch", "request-record-failed"],
		["request", "request-record-failed"],
		["idle", "parent-started"],
		["cancel", "user-cancelled"],
		["generation", "session-changed"],
		["deadline", "jev-timeout"],
	] as const)
		it(`fences ${change} from the actual terminal pending observation without reopening callbacks`, async () => {
			const source = join(
				mkdtempSync(join(tmpdir(), "ar-terminal-config-")),
				"config.json",
			);
			writeFileSync(source, "approved durable config");
			const config = { ...routingConfig("auto"), source };
			let loaders: number | undefined;
			let pendingReads = 0;
			let now = 0;
			const run = routing({
				config: () => {
					if (loaders !== undefined && ++loaders === 6 && change === "deadline")
						now = 4_980; // 20 ms left at the last injected-clock sample.
					return config;
				},
				clock: () => now,
				launch: realLaunch,
			});
			const seam = useAutoPiSeam({
				ready: async () => {
					loaders = 0;
					run.ctx.hasPendingMessages = () => {
						if (++pendingReads === 4) {
							assert.equal(loaders, 6, "all loaders already finished");
							if (change === "cwd") run.ctx.cwd = tmpdir();
							if (change === "session")
								run.ctx.sessionManager = persistedSession().manager;
							// The real loader's authority is durable. Virtual loader
							// backing-state-only mutations have no callback-free fence.
							if (change === "config revoked") writeFileSync(source, "off");
							if (change === "config changed")
								writeFileSync(source, "changed approval");
							if (change === "branch")
								run.manager.appendCustomEntry("unrelated", {});
							if (change === "request") {
								const file = run.manager.getSessionFile()!;
								writeFileSync(
									file,
									readFileSync(file, "utf8").replace(
										"BEGIN REQUEST",
										"BEGIN REQUESX",
									),
								);
							}
							if (change === "idle") run.state.idle = false;
							if (change === "cancel") run.coordinator.cancel();
							if (change === "generation")
								run.coordinator.onLifecycle("session_before_tree");
							if (change === "deadline")
								// One bounded delay, not a retry/poll or injected clock
								// advance: real elapsed time must spend the allowance.
								Atomics.wait(
									new Int32Array(new SharedArrayBuffer(4)),
									0,
									0,
									30,
								);
						}
						return false;
					};
				},
			});
			assert.deepEqual(await run.input(), HANDLED);
			assert.equal(pendingReads, 4, "the actual terminal observation ran");
			assert.equal(loaders, 6, "no loader ran after it");
			assert.deepEqual(seam.events, ["create", "ready"], "no runScript");
			assert.deepEqual(seam.closed, ["auto-pi-pane"]);
			assert.equal(run.triggered().length, 0, "no parent fallback");
			assert.equal(run.coordinator.snapshotStatus().last?.phase, "held");
			assert.equal(run.coordinator.snapshotStatus().last?.reason, reason);
			assert.equal(run.coordinator.snapshotStatus().retained, undefined);
		});
});

describe("input coordinator: callback-free mutation fence (T08R-F004)", () => {
	for (const change of [
		"cwd",
		"session",
		"durable config",
		"request",
		"role snapshot",
	] as const)
		it(`fences ${change} mutation even inside the last loader callback`, async () => {
			const roleFile = join(
				process.env.PI_CODING_AGENT_DIR!,
				"agents",
				`${ROUTED_ROLE}.md`,
			);
			let savedRole: string | undefined;
			const source = join(
				mkdtempSync(join(tmpdir(), "ar-boundary-config-")),
				"config.json",
			);
			writeFileSync(source, "original durable config");
			const config = { ...routingConfig("auto"), source };
			let reads: number | undefined;
			let run!: ReturnType<typeof routing>;
			run = routing({
				config: () => {
					if (reads !== undefined && ++reads === 6) {
						if (change === "cwd") run.ctx.cwd = tmpdir();
						if (change === "session")
							run.ctx.sessionManager = persistedSession().manager;
						if (change === "durable config")
							writeFileSync(source, "revoked durable config!");
						if (change === "role snapshot") {
							savedRole = readFileSync(roleFile, "utf8");
							writeFileSync(
								roleFile,
								`${savedRole}\nChanged role instructions.\n`,
							);
						}
						if (change === "request") {
							const file = run.manager.getSessionFile()!;
							writeFileSync(
								file,
								readFileSync(file, "utf8").replace(
									"BEGIN REQUEST",
									"BEGIN REQUESX",
								),
							);
						}
					}
					// Deliberately returns the old approved config after writing.
					return config;
				},
				launch: realLaunch,
			});
			const seam = useAutoPiSeam({
				ready: async () => {
					reads = 0;
				},
			});
			try {
				assert.deepEqual(await run.input(), HANDLED);
			} finally {
				if (savedRole !== undefined) writeFileSync(roleFile, savedRole);
			}
			assert.ok((reads ?? 0) >= 6, "the final loader callback ran");
			assert.deepEqual(seam.events, ["create", "ready"]);
			assert.deepEqual(seam.closed, ["auto-pi-pane"]);
			assert.equal(run.triggered().length, 0);
			assert.equal(run.coordinator.snapshotStatus().last?.phase, "held");
			assert.equal(run.coordinator.snapshotStatus().retained, undefined);
		});
});

describe("input coordinator: hostile retained stores (T08R-F005)", () => {
	/**
	 * A store whose chosen methods throw once armed (admission itself fails
	 * closed on an unreadable store), recording every call.
	 */
	function hostileStore(throwing: ReadonlyArray<"get" | "set" | "resolved">) {
		const calls: string[] = [];
		const state = { armed: false };
		let kept: any;
		const hostile = (method: "get" | "set" | "resolved", name: string) => {
			calls.push(name);
			if (state.armed && throwing.includes(method))
				throw new Error(`${name} failed`);
		};
		return {
			calls,
			state,
			get: () => {
				hostile("get", "get");
				return kept;
			},
			set: (work: any) => {
				hostile("set", "set");
				kept = work;
			},
			resolved: {
				has: (_id: string) => {
					hostile("resolved", "resolved.has");
					return false;
				},
				add: (_id: string) => {
					hostile("resolved", "resolved.add");
				},
			},
		};
	}
	const armedLaunch =
		(store: ReturnType<typeof hostileStore>) =>
		(handoff: AutoLaunchHandoff<any, any>) => {
			store.state.armed = true;
			return realLaunch(handoff);
		};

	it("keeps a send-then-throw dispatch uncertain when the store fails", async () => {
		const store = hostileStore(["get", "set", "resolved"]);
		const run = routing({ retained: store, launch: armedLaunch(store) });
		const seam = useAutoPiSeam({
			run: () => {
				throw new Error("acknowledgement lost after sending");
			},
		});
		assert.deepEqual(await run.input(), HANDLED);
		assert.ok(store.calls.includes("set"), "the store was asked to retain");
		assert.equal(store.calls.includes("resolved.add"), false, "never no-work");
		assert.equal(seam.events.filter((event) => event === "run").length, 1);
		assert.deepEqual(seam.closed, []);
		// Never no-work: no held record or status, no fallback, no retry.
		assert.equal(run.triggered().length, 0);
		assert.deepEqual(
			run.statuses().map((status) => status.details.state),
			["uncertain"],
		);
		assert.deepEqual(
			run.receipts().map((receipt) => receipt.data.phase),
			["uncertain"],
		);
		const status = run.coordinator.snapshotStatus();
		assert.equal(status.last?.phase, "uncertain");
		assert.equal(status.retained?.state, "uncertain");
		const calls = run.transport.calls.length;
		assert.deepEqual(await run.input("Another request."), CONTINUE);
		assert.equal(run.transport.calls.length, calls, "blocked: no egress");
		assert.equal(seam.events.filter((event) => event === "run").length, 1);
	});

	it("still installs the watcher and delivers once when every store method throws", async () => {
		const store = hostileStore(["get", "set", "resolved"]);
		const run = routing({ retained: store, launch: armedLaunch(store) });
		useAutoPiSeam();
		assert.deepEqual(await run.input(), HANDLED);
		const id = run.statuses()[0].details.decisionId;
		const result = await flow.waitForMessage(
			(message) =>
				message.customType === "subagent_result" &&
				message.details?.autoRouting?.decisionId === id,
		);
		assert.equal(result.details.autoRouting.decisionId, id);
		assert.equal(run.statuses()[0].details.state, "started");
		assert.equal(run.triggered().length, 0);
		assert.equal(run.coordinator.snapshotStatus().last?.phase, "dispatched");
		assert.deepEqual(
			run.receipts().map((receipt) => receipt.data.phase),
			["dispatched"],
		);
		// An unreadable store stays busy: no second egress or dispatch.
		const calls = run.transport.calls.length;
		assert.deepEqual(await run.input("Another request."), CONTINUE);
		assert.equal(run.transport.calls.length, calls);
		assert.equal(run.launches.length, 1);
		assert.equal(
			store.calls.filter((call) => call === "resolved.add").length,
			1,
			"settlement is local and single-use even when resolved.add throws",
		);
		const status = run.coordinator.snapshotStatus();
		assert.equal(status.retained, undefined, "the watcher settled locally");
		assert.equal(status.retainedUnavailable, true);
		assert.match(
			formatAutoRoutingStatus(status),
			/Unknown: retained automatic work/,
		);
	});

	it("never downgrades a supervised start when the outer handoff throws", async () => {
		const store = hostileStore(["get", "set", "resolved"]);
		const settled = deferred<void>();
		const run = routing({
			retained: store,
			launch: async (handoff) => {
				store.state.armed = true;
				const outcome = await realLaunch(handoff);
				assert.equal(outcome.status, "started");
				throw new Error("outer acknowledgement failed after started");
			},
		});
		useAutoPiSeam({
			watch: async (child: any) => {
				await settled.promise;
				return {
					name: child.name,
					task: child.task,
					summary: "supervised result",
					exitCode: 0,
					elapsed: 0,
					sessionFile: child.sessionFile,
				};
			},
		});
		assert.deepEqual(await run.input(), HANDLED);
		const status = run.coordinator.snapshotStatus();
		assert.equal(status.last?.phase, "dispatched");
		assert.equal(status.retained?.state, "dispatched");
		assert.equal(run.triggered().length, 0);
		assert.deepEqual(
			run.receipts().map((receipt) => receipt.data.phase),
			["dispatched"],
		);
		assert.deepEqual(
			run.statuses().map((message) => message.details.state),
			["started"],
		);
		const id = status.retained!.decisionId;
		settled.resolve();
		await flow.waitForMessage(
			(message) =>
				message.customType === "subagent_result" &&
				message.details?.autoRouting?.decisionId === id,
		);
		await until(() => run.coordinator.snapshotStatus().retained === undefined);
		assert.equal(
			store.calls.filter((call) => call === "resolved.add").length,
			1,
		);
	});

	it("recovers durable unknown work on reload after a failed uncertainty write", async () => {
		const store = hostileStore(["set", "resolved"]);
		const before = routing({ retained: store, launch: armedLaunch(store) });
		const seam = useAutoPiSeam({
			run: () => {
				throw new Error("sent then lost");
			},
		});
		assert.deepEqual(await before.input(), HANDLED);
		assert.equal(
			before.coordinator.snapshotStatus().retained?.state,
			"uncertain",
		);
		assert.equal(store.get(), undefined);
		const after = routing({ manager: before.manager, retained: store });
		assert.deepEqual(await after.input("Another request."), CONTINUE);
		assert.equal(
			after.coordinator.snapshotStatus().recovery?.status,
			"unknown",
		);
		assert.equal(after.transport.calls.length, 0);
		assert.equal(after.launches.length, 0);
		assert.equal(after.triggered().length, 0);
		assert.equal(seam.events.filter((event) => event === "run").length, 1);
	});

	it("holds the slot locally while a store that cannot write keeps nothing", async () => {
		const store = hostileStore(["set"]);
		const settle = deferred<void>();
		const run = routing({
			retained: store,
			launch: armedLaunch(store),
			// The map no longer shows the child: only the local mirror holds it.
			childRunning: () => false,
		});
		useAutoPiSeam({
			watch: async (child: any) => {
				await settle.promise;
				return {
					name: child.name,
					task: child.task,
					summary: "done",
					exitCode: 0,
					elapsed: 0,
					sessionFile: child.sessionFile,
				};
			},
		});
		assert.deepEqual(await run.input(), HANDLED);
		const id = run.statuses()[0].details.decisionId;
		assert.equal(store.get(), undefined, "the store kept nothing");
		assert.equal(run.coordinator.snapshotStatus().retained?.decisionId, id);
		assert.deepEqual(await run.input("Another request."), CONTINUE);
		assert.equal(run.transport.calls.length, 2, "busy: no egress");
		settle.resolve();
		await flow.waitForMessage(
			(message) =>
				message.customType === "subagent_result" &&
				message.details?.autoRouting?.decisionId === id,
		);
		await until(() => run.coordinator.snapshotStatus().retained === undefined);
		// Settled locally once: the next prompt routes again.
		assert.deepEqual(await run.input("A third request."), HANDLED);
		assert.equal(run.launches.length, 2);
	});
});

describe("input coordinator: a bound native child (T08)", () => {
	for (const outcome of ["success", "failure"] as const)
		it(`guards, strips the Jev key, and carries the receipt on native ${outcome}`, async () => {
			const project = mkdtempSync(join(tmpdir(), "ar-native-"));
			const log = join(project, `native-${outcome}.json`);
			const run = routing({
				config: () =>
					routingConfig("auto", "parent", "high", {
						harness: "claude",
						id: "claude-dest-4",
					}),
				launch: realLaunch,
			});
			const herdr = flow.useHerdr(
				outcome === "failure"
					? {
							log,
							env: {
								TYPESAFE_API_KEY: "parent-secret",
								FAKE_FAIL_MODEL: "claude-dest-4",
							},
						}
					: { log, env: { TYPESAFE_API_KEY: "parent-secret" } },
			);
			assert.deepEqual(await run.input(), HANDLED);
			const [started] = run.statuses();
			assert.equal(started.details.state, "started");
			assert.equal(started.details.harness, "claude");
			const id = started.details.decisionId;
			const result = await flow.waitForMessage(
				(message) =>
					message.customType === "subagent_result" &&
					message.details?.autoRouting?.decisionId === id,
			);
			assert.equal(result.details.autoRouting.selectionSource, "auto");
			assert.equal(result.details.native.model, "claude-dest-4");
			assert.equal(result.details.runtimeProvenance.model.source, "auto");
			if (outcome === "success")
				assert.equal(result.details.exitCode, 0, result.content);
			else assert.notEqual(result.details.exitCode, 0);
			// One exact model: no native fallback attempt follows.
			assert.equal(herdr.events.filter((event) => event === "run").length, 1);
			const launched = JSON.parse(readFileSync(log, "utf8"));
			assert.equal(launched.typesafeKey, null);
			assert.equal(launched.autoRoutingDisabled, "1");
			const args: string[] = launched.args;
			assert.equal(args[args.indexOf("--model") + 1], "claude-dest-4");
			await until(
				() => run.coordinator.snapshotStatus().retained === undefined,
			);
			assert.equal(run.triggered().length, 0);
		});
});
