/** T10: actual editor -> public input -> authenticated classifier adapter ->
 * real Herdr child -> existing result delivery. RPC is BYPASS evidence only.
 * No direct input calls, launch replacements, host patches or live credentials.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	readlinkSync,
	openSync,
	fstatSync,
	readSync,
	closeSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	cleanupTestEnv,
	createTestEnv,
	createTrackedSurface,
	focusSurface,
	getFocusedSurface,
	startIdleTui,
	submitEditorInput,
	runInPane,
	shellQuote,
	waitForPaneReady,
	waitForPredicate,
	waitForScreen,
	readPane,
	type TestEnv,
} from "./harness.ts";
import type { RoutingScenario } from "./auto-routing-fixture.ts";
import { BypassRpcDriver } from "./rpc-driver.ts";
import {
	routingSuiteSkip,
	routingLabEnvironment,
	routingProcessEnvironment,
	replaceEnvironment,
	serverExited,
	teardownRoutingLab,
} from "./auto-routing-lab.ts";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";

const fixture = fileURLToPath(
	new URL("./auto-routing-fixture.ts", import.meta.url),
);
const nativeBin = fileURLToPath(
	new URL("../fixtures/native-bin", import.meta.url),
);
const TASK =
	"Inspect the parser and report a bounded finding. INTEGRATION_AUTO_ROUTE:case";
function completeJsonlRecords(content: string): any[] {
	// An append may be observed before its terminating LF. Defer only that
	// tail; malformed completed records must still fail the observation.
	const end = content.lastIndexOf("\n");
	return end < 0
		? []
		: content
				.slice(0, end)
				.split("\n")
				.filter((s) => s.trim())
				.map((s) => JSON.parse(s));
}
function lines(path: string): any[] {
	if (!existsSync(path)) return [];
	const fd = openSync(path, "r");
	try {
		// Capture one bounded snapshot, without chasing concurrent appends.
		const size = fstatSync(fd).size;
		if (size > 16 * 1024 * 1024)
			throw new Error(`Oversized integration JSONL: ${path}`);
		const buffer = Buffer.alloc(size);
		const bytes = readSync(fd, buffer, 0, size, 0);
		return completeJsonlRecords(buffer.subarray(0, bytes).toString("utf8"));
	} finally {
		closeSync(fd);
	}
}
function journal(env: TestEnv): any[] {
	return lines(join(env.dir, "journal.jsonl"));
}
function entries(env: TestEnv): any[] {
	const file = journal(env).findLast((e) => e.session)?.session;
	return file ? lines(file) : [];
}
function customs(env: TestEnv, type: string) {
	return entries(env).filter(
		(e) => e.message?.customType === type || e.customType === type,
	);
}
function calls(env: TestEnv) {
	return journal(env).filter((e) => e.kind === "classifier");
}
function results(env: TestEnv) {
	return customs(env, "subagent_result");
}
async function waitEvent(env: TestEnv, kind: string, count = 1) {
	await waitForPredicate(
		() => journal(env).filter((e) => e.kind === kind).length >= count,
		`${kind} ${count}`,
	);
}

function processesIn(root: string): number[] {
	return readdirSync("/proc")
		.filter((p) => /^\d+$/.test(p))
		.flatMap((p) => {
			try {
				const cwd = readlinkSync(`/proc/${p}/cwd`);
				const argv = readFileSync(`/proc/${p}/cmdline`, "utf8");
				return cwd.startsWith(root) || argv.includes(root) ? [Number(p)] : [];
			} catch {
				return [];
			} // vanished/protected processes are not cleanup authority
		});
}
function workspaces(): any[] {
	return JSON.parse(
		execFileSync("herdr", ["workspace", "list"], { encoding: "utf8" }),
	).result.workspaces;
}

describe("automatic routing through installed Pi TUI and real Herdr", {
	skip: routingSuiteSkip(process.env),
	timeout: 900000,
}, () => {
	let env: TestEnv;
	let surface: string;
	let originalFocus: string | null;
	let lab: string | undefined;
	let server: ReturnType<typeof spawn> | undefined;
	let serverFailure: Error | undefined;
	let rootWorkspaceId: string | undefined;
	const savedEnv = { ...process.env };
	before(async () => {
		// Native commands must resolve to fixtures in EVERY new pane, not merely
		// in the parent's exported shell. A private test-owned real Herdr server
		// provides that environment; the user's server/config are untouched.
		lab = mkdtempSync("/tmp/jev-t10-herdr-");
		const home = join(lab, "home");
		const socket = join(home, ".config/herdr/sessions/jev-t10/herdr.sock");
		mkdirSync(join(home, ".config/herdr/sessions/jev-t10"), {
			recursive: true,
		});
		const config = join(lab, "config.toml");
		const tmp = join(lab, "tmp");
		mkdirSync(tmp);
		writeFileSync(
			config,
			'onboarding = false\n[terminal]\ndefault_shell = "/bin/bash"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n[experimental]\nallow_nested = true\n',
		);
		writeFileSync(
			join(home, ".config/herdr/sessions/jev-t10/config.toml"),
			readFileSync(config),
		);
		replaceEnvironment(
			process.env,
			routingLabEnvironment(savedEnv, {
				home,
				tmp,
				config,
				socket,
				nativeBin,
				nativeLog: join(lab, "native.json"),
			}),
		);
		assert.equal(
			execFileSync("pi", ["--version"], { encoding: "utf8" }).trim(),
			"0.99.1",
			"T10 current-host evidence must not silently use another Pi CLI",
		);
		server = spawn("herdr", ["--session", "jev-t10", "server"], {
			env: process.env,
			stdio: "ignore",
		});
		server.on("error", (error) => {
			serverFailure = error;
		});
		const startedServer = server;
		await waitForPredicate(
			() =>
				existsSync(socket) || !!serverFailure || serverExited(startedServer),
			"isolated real Herdr socket",
			15000,
		);
		if (serverFailure) throw serverFailure;
		if (serverExited(startedServer))
			throw new Error("Isolated Herdr exited during startup");
		const root = JSON.parse(
			execFileSync(
				"herdr",
				[
					"workspace",
					"create",
					"--label",
					"pi-integ-routing-root",
					"--cwd",
					home,
					"--no-focus",
				],
				{ encoding: "utf8" },
			),
		).result;
		rootWorkspaceId = root.workspace.workspace_id;
		Object.assign(process.env, {
			HERDR_WORKSPACE_ID: root.workspace.workspace_id,
			HERDR_PANE_ID: root.root_pane.pane_id,
			HERDR_TAB_ID: root.root_pane.tab_id,
		});
		originalFocus = getFocusedSurface("herdr");
	});
	after(async () => {
		await teardownRoutingLab({
			server,
			spawnFailure: serverFailure,
			lab,
			rootWorkspaceId,
			closeRoot: (id) => {
				execFileSync("herdr", ["workspace", "close", id], {
					encoding: "utf8",
					timeout: 5000,
				});
			},
			stopServer: () => {
				execFileSync("herdr", ["server", "stop"], {
					encoding: "utf8",
					timeout: 5000,
				});
			},
			waitExit: (child) =>
				waitForPredicate(
					() => serverExited(child, !!serverFailure),
					"test-owned server exit",
					5000,
				),
			waitLabQuiet: (root) =>
				waitForPredicate(
					() => processesIn(root).length === 0,
					"test-owned lab processes exited",
					10000,
				),
			removeLab: (root) => rmSync(root, { recursive: true, force: true }),
			restoreEnvironment: () => replaceEnvironment(process.env, savedEnv),
		});
	});
	afterEach(async () => {
		if (env) {
			try {
				writeFileSync(
					`/tmp/jev-t10-${env.workspaceId}.json`,
					JSON.stringify(
						{
							journal: journal(env),
							entries: entries(env),
							provider: getProviderRequests(),
							files: readdirSync(env.dir, { recursive: true })
								.filter(
									(p) =>
										String(p).endsWith(".sh") || String(p).endsWith(".jsonl"),
								)
								.map((p) => ({
									path: p,
									content: readFileSync(join(env.dir, String(p)), "utf8"),
								})),
							screen: surface ? readPane(surface, 180) : "",
						},
						null,
						2,
					),
				);
			} finally {
				cleanupTestEnv(env);
			}
			await waitForPredicate(
				() => processesIn(env.dir).length === 0,
				"test-owned project processes exited",
				10000,
			);
			assert.equal(existsSync(env.dir), false);
			assert.equal(
				workspaces().some((w) => w.workspace_id === env.workspaceId),
				false,
			);
			assert.equal(
				workspaces().length,
				1,
				"only test lab root workspace remains; no auto worktree",
			);
		}
		if (originalFocus) {
			focusSurface("herdr", originalFocus);
			assert.equal(getFocusedSurface("herdr"), originalFocus);
		}
	});
	async function start(options: RoutingScenario = {}, seed = true) {
		resetProviderRequests();
		env = createTestEnv("herdr");
		writeFileSync(
			join(env.dir, ".pi", "agents", "auto-reporter.md"),
			"---\nname: auto-reporter\ndescription: Offline bounded reporter\ntools: read\nauto-exit: true\nspawning: false\nsession-mode: standalone\n---\nReport a bounded finding. Never modify files or delegate.\n",
		);
		writeFileSync(join(env.dir, "scenario.json"), JSON.stringify(options));
		const wrapper = join(env.dir, "fixture.ts");
		writeFileSync(
			wrapper,
			`export { default } from ${JSON.stringify(fixture)};\n`,
		);
		surface = createTrackedSurface(env, "routing-parent");
		await waitForPaneReady(surface);
		runInPane(
			surface,
			`unset PI_SUBAGENT_ID PI_SUBAGENT_SESSION PI_SUBAGENT_NAME PI_SUBAGENT_AGENT PI_SUBAGENT_AUTO_EXIT PI_SUBAGENT_PERSISTENT PI_SUBAGENT_GENERATION_ID PI_SUBAGENT_TASK_ID PI_HERDR_AUTO_ROUTING_DISABLED; export AUTO_INTEG_ROOT=${shellQuote(env.dir)} TYPESAFE_API_KEY=offline-jev-token PI_OFFLINE=1 PI_TELEMETRY=0 PATH=${shellQuote(nativeBin)}:"$PATH" FAKE_NATIVE_LOG=${shellQuote(join(env.dir, "native.json"))}`,
		);
		startIdleTui(surface, env.dir, { extension: wrapper });
		await waitEvent(env, "session_start");
		assert.equal(journal(env).at(-1).mode, "tui");
		await probe();
		if (seed) {
			submitEditorInput(
				surface,
				"Seed this ordinary conversation. [no-auto-route]",
			);
			await waitEvent(env, "agent_settled");
			assert.ok(entries(env).some((e) => e.message?.role === "user"));
			assert.ok(entries(env).some((e) => e.message?.role === "assistant"));
			await probe();
		}
		return wrapper;
	}
	async function probe() {
		const count = journal(env).filter((e) => e.kind === "probe").length + 1;
		submitEditorInput(surface, "/integ-probe");
		await waitEvent(env, "probe", count);
		const observation = journal(env).findLast((e) => e.kind === "probe");
		assert.equal(observation.idle, true);
		assert.equal(observation.pending, false);
	}
	for (const harness of ["pi", "claude", "kiro"] as const) {
		it(`${harness}: exactly one approved ordinary child, disk request, result and parent synthesis`, async () => {
			await start({ harness });
			const focus = getFocusedSurface("herdr");
			submitEditorInput(surface, TASK);
			await waitForPredicate(
				() => customs(env, "jev_auto_request").length === 1,
				"disk request",
			);
			await waitForPredicate(() => {
				const panes = JSON.parse(
					execFileSync(
						"herdr",
						["pane", "list", "--workspace", env.workspaceId],
						{ encoding: "utf8" },
					),
				).result.panes;
				for (const pane of panes ?? [])
					if (
						pane.pane_id !== surface &&
						pane.pane_id !== process.env.HERDR_PANE_ID
					) {
						try {
							writeFileSync(
								`/tmp/jev-t10-child-${harness}.txt`,
								readPane(pane.pane_id, 200),
							);
						} catch {}
					}
				return results(env).length === 1;
			}, "correlated auto result");
			await waitEvent(env, "agent_settled", 2);
			assert.equal(calls(env).length, 2, JSON.stringify(journal(env)));
			assert.equal(customs(env, "jev_auto_request").length, 1);
			assert.equal(results(env).length, 1);
			const request = customs(env, "jev_auto_request")[0];
			const result = results(env)[0];
			const all = entries(env);
			assert.ok(
				all.findIndex((e) => e.id === request.id) <
					all.findIndex((e) => e.id === result.id),
			);
			// The real launch script is generated before runScript dispatch. Its
			// timestamp must follow the durably confirmed captured request.
			const scripts = readdirSync(env.dir, { recursive: true }).filter(
				(p) =>
					String(p).includes("subagent-scripts/") && String(p).endsWith(".sh"),
			);
			assert.equal(scripts.length, 1);
			const script = readFileSync(join(env.dir, String(scripts[0])), "utf8");
			const generated = script.match(/# Generated: ([^\n]+)/)?.[1];
			assert.ok(generated);
			assert.ok(Date.parse(request.timestamp) <= Date.parse(generated));
			const details = result.message?.details ?? result.details;
			assert.ok(details.autoRouting);
			assert.equal(details.selection.harness, harness);
			assert.equal(details.selection.harnessSource, "auto");
			assert.equal(details.runtimeProvenance.model.source, "auto");
			assert.equal(details.runtimeProvenance.thinking.source, "auto");
			if (harness === "pi") {
				assert.equal(details.runtimePlan.model, "pi-integration/test");
				assert.equal(details.runtimePlan.thinking, "high");
			}
			assert.equal(
				all.filter((e) => e.type === "model_change").length,
				1,
				"parent model unchanged",
			);
			assert.equal(details.exitCode, 0);
			assert.equal(
				details.autoRouting.decisionId,
				request.message?.details?.decisionId ?? request.details?.decisionId,
			);
			assert.equal(details.worktree, undefined);
			assert.match(
				JSON.stringify(result),
				harness === "pi"
					? /AUTO_CHILD_case/
					: new RegExp(
							`${harness === "claude" ? "Claude" : "Kiro"} fixture result`,
						),
			);
			assert.ok(
				entries(env).some(
					(e) =>
						e.message?.role === "assistant" &&
						JSON.stringify(e).includes("AUTO_SYNTHESIS_case"),
				),
				JSON.stringify(entries(env)),
			);
			assert.equal(getFocusedSurface("herdr"), focus);
			if (harness !== "pi") {
				const args = JSON.parse(
					readFileSync(join(lab!, "native.json"), "utf8"),
				).args;
				assert.equal(
					args[args.indexOf("--model") + 1],
					`${harness}-fixture-20260930`,
				);
				assert.equal(args[args.indexOf("--effort") + 1], "high");
				assert.equal(details.native.processExit, "confirmed");
				assert.equal(details.native.turns.length, 1);
			}
		});
	}
	it("fresh unpersisted TUI conversation bypasses with normal parent handling", async () => {
		await start({}, false);
		assert.equal(entries(env).length, 0);
		submitEditorInput(surface, TASK);
		await waitEvent(env, "agent_settled");
		assert.equal(calls(env).length, 0);
		assert.equal(results(env).length, 0);
		assert.match(JSON.stringify(entries(env)), /AUTO_PARENT_case/);
	});
	for (const reason of ["unavailable", "abstain"] as const) {
		it(`unowned ${reason} continues ordinary parent input`, async () => {
			await start({ [reason]: true });
			submitEditorInput(surface, TASK);
			await waitEvent(env, "agent_settled", 2);
			assert.equal(calls(env).length, 1);
			assert.equal(customs(env, "jev_auto_request").length, 0);
			assert.equal(results(env).length, 0);
			assert.match(JSON.stringify(entries(env)), /AUTO_PARENT_case/);
		});
	}

	it("ordered real input transforms: added current image bypasses; transformed prose routes and suppresses later handler", async () => {
		// The journal/session observer must tolerate exactly an in-progress
		// tail, not hide a corrupted complete line or a completed malformed tail.
		assert.deepEqual(completeJsonlRecords('{"ready":true}\n{"text":"half'), [
			{ ready: true },
		]);
		assert.deepEqual(completeJsonlRecords('{"ready":true}'), []);
		assert.deepEqual(completeJsonlRecords('{"ready":true}\n{"next":2}\n'), [
			{ ready: true },
			{ next: 2 },
		]);
		assert.throws(
			() => completeJsonlRecords('{"broken":}\n{"text":"half'),
			SyntaxError,
		);
		assert.throws(
			() => completeJsonlRecords('{"ready":true}\n{"text":"half\n'),
			SyntaxError,
		);
		await start({ transform: true });
		submitEditorInput(surface, `IMAGE:${TASK}`);
		await waitEvent(env, "agent_settled", 2);
		assert.equal(calls(env).length, 0);
		assert.equal(results(env).length, 0);
		await probe();
		submitEditorInput(surface, `TRANSFORM:${TASK}`);
		await waitForPredicate(
			() => results(env).length === 1,
			"transformed route result",
		);
		await waitEvent(env, "agent_settled", 3);
		assert.equal(calls(env).length, 2);
		assert.equal(calls(env)[0].body.state.prompt, TASK);
		assert.equal(
			journal(env).filter((e) => e.kind === "after-input" && e.text === TASK)
				.length,
			1,
			"image input continues; owned transformed prose suppresses later handler",
		);
	});

	it("visible slash and bang commands bypass classification", async () => {
		await start();
		submitEditorInput(surface, "/subagents-routing status");
		await waitForScreen(
			surface,
			/Automatic routing|auto.*routing|Jev|jev-auto-v1/i,
			10000,
		);
		await probe();
		const marker = join(env.dir, "bang-result");
		submitEditorInput(surface, `!printf normal-bash > ${marker}`);
		await waitForPredicate(() => existsSync(marker), "normal bang command");
		assert.equal(readFileSync(marker, "utf8"), "normal-bash");
		assert.equal(calls(env).length, 0);
		assert.equal(results(env).length, 0);
	});

	it("real streaming TUI Enter/Alt-Enter steer and followUp bypass", async () => {
		await start();
		const gate = join(env.dir, "stream-release");
		submitEditorInput(
			surface,
			`[no-auto-route] INTEGRATION_WAIT_FOR_FILE: ${gate}`,
		);
		await waitForPredicate(
			() => getProviderRequests().some((r) => r.lastUser?.includes(gate)),
			"active model request",
		);
		submitEditorInput(surface, TASK);
		await waitForPredicate(
			() =>
				journal(env).some(
					(e) => e.kind === "before-input" && e.streamingBehavior === "steer",
				),
			"streaming editor steer",
		);
		submitEditorInput(surface, TASK, "alt+enter");
		await waitForPredicate(
			() =>
				journal(env).some(
					(e) =>
						e.kind === "before-input" && e.streamingBehavior === "followUp",
				),
			"streaming editor followUp",
		);
		writeFileSync(gate, "release");
		await waitEvent(env, "agent_settled", 2);
		await probe();
		assert.equal(calls(env).length, 0);
		assert.equal(results(env).length, 0);
	});

	it("classifier deadline discards a genuine late transport response; Escape is only an observation", async (t) => {
		await start({ delay: true, timeoutMs: 500 });
		submitEditorInput(surface, TASK);
		await waitEvent(env, "classifier");
		execFileSync("herdr", ["pane", "send-keys", surface, "esc"]);
		await waitEvent(env, "agent_settled", 2);
		const receipt = customs(env, "jev_auto_route_v1").at(-1);
		assert.match(JSON.stringify(receipt), /jev-timeout/);
		assert.equal(customs(env, "jev_auto_request").length, 0);
		writeFileSync(join(env.dir, "classifier-release"), "late response");
		await waitEvent(env, "classifier-response");
		await probe();
		assert.equal(calls(env).length, 1);
		assert.equal(results(env).length, 0);
		t.diagnostic(
			"Escape emitted no observable package cancellation event; the recorded outcome is jev-timeout, not cancelled.",
		);
	});

	it("observe public local cancel during idle classification (blocker if command is delayed)", async (t) => {
		await start({ delay: true });
		submitEditorInput(surface, TASK);
		await waitEvent(env, "classifier");
		submitEditorInput(surface, "/subagents-routing cancel");
		await waitForPredicate(
			() => customs(env, "jev_auto_route_v1").length > 0,
			"cancel or authoritative deadline receipt",
		);
		const cancelled = customs(env, "jev_auto_route_v1").some((e) =>
			JSON.stringify(e).includes("user-cancelled"),
		);
		writeFileSync(join(env.dir, "classifier-release"), "late");
		await waitEvent(env, "classifier-response");
		await probe();
		assert.equal(results(env).length, 0);
		if (cancelled)
			assert.equal(
				journal(env).filter((e) => e.kind === "agent_start").length,
				1,
				"cancelled request held",
			);
		else {
			assert.match(
				JSON.stringify(customs(env, "jev_auto_route_v1")),
				/jev-timeout/,
			);
			t.skip(
				"Pi 0.99.1 delays the local cancel command until the awaited input resolves; deadline, not cancellation, was observable.",
			);
		}
	});

	it("observe public session replacement before dispatch (blocker if idle wait delays it)", async (t) => {
		await start({ delay: true });
		const oldSession = journal(env).findLast(
			(e) => e.kind === "session_start",
		).session;
		submitEditorInput(surface, TASK);
		await waitEvent(env, "classifier");
		submitEditorInput(surface, "/integ-new");
		await waitEvent(env, "session_start", 2);
		assert.notEqual(
			journal(env).findLast((e) => e.kind === "session_start").session,
			oldSession,
		);
		writeFileSync(join(env.dir, "classifier-release"), "late");
		await waitEvent(env, "classifier-response");
		await probe();
		assert.equal(results(env).length, 0);
		assert.equal(
			entries(env).some((e) => JSON.stringify(e).includes(TASK)),
			false,
		);
		const old = lines(oldSession);
		const outcome = old.findLast((e) => e.customType === "jev_auto_route_v1");
		if (JSON.stringify(outcome).includes("jev-timeout")) {
			assert.ok(
				old.some(
					(e) => e.message?.role === "user" && JSON.stringify(e).includes(TASK),
				),
			);
			t.skip(
				"Pi 0.99.1 newSession waits for idle input to resolve: transition occurred after deadline and normal parent handling, not pre-dispatch cancellation.",
			);
		} else assert.match(JSON.stringify(outcome), /stale|cancel|session/);
	});

	it("pilot decline consumes the captured request without child or parent execution", async () => {
		await start({ mode: "pilot" });
		submitEditorInput(surface, TASK);
		await waitForScreen(
			surface,
			/Delegate this request to an automatically selected subagent\?/,
			10000,
		);
		execFileSync("herdr", ["pane", "send-keys", surface, "esc"]);
		await waitForPredicate(
			() =>
				customs(env, "jev_auto_route_v1").some((e) =>
					JSON.stringify(e).includes("pilot-declined"),
				),
			"real pilot decline",
		);
		assert.equal(customs(env, "jev_auto_request").length, 1);
		assert.equal(results(env).length, 0);
		assert.equal(
			journal(env).filter((e) => e.kind === "agent_start").length,
			1,
		);
	});

	it("reload while the automatic child is active retains existing replacement-parent delivery", async () => {
		await start();
		const gate = join(env.dir, "child-release");
		submitEditorInput(surface, `${TASK} INTEGRATION_WAIT_FOR_FILE: ${gate}`);
		await waitForPredicate(
			() =>
				getProviderRequests().some(
					(r) => !r.tools?.includes("subagent") && r.lastUser?.includes(gate),
				),
			"real child model request",
		);
		assert.equal(results(env).length, 0);
		submitEditorInput(surface, "/reload");
		await waitEvent(env, "session_start", 2);
		writeFileSync(gate, "release");
		await waitForPredicate(
			() => results(env).length === 1,
			"result through replacement parent API",
		);
		await waitEvent(env, "agent_settled", 2);
		assert.equal(calls(env).length, 2);
		assert.equal(results(env).length, 1);
		assert.match(JSON.stringify(entries(env)), /AUTO_SYNTHESIS_case/);
	});

	for (const policy of ["parent", "hold"] as const) {
		it(`owned known-no-dispatch config revocation uses ${policy} policy`, async () => {
			await start({ mode: "pilot", failurePolicy: policy });
			submitEditorInput(surface, TASK);
			await waitForScreen(
				surface,
				/Delegate this request to an automatically selected subagent\?/,
				10000,
			);
			assert.equal(customs(env, "jev_auto_request").length, 1);
			const config = join(
				env.dir,
				".pi",
				"agent",
				"herdr-agents",
				"config.json",
			);
			writeFileSync(
				config,
				JSON.stringify({
					status: { enabled: true },
					autoRouting: { version: 1, mode: "off" },
				}),
			);
			execFileSync("herdr", ["pane", "send-keys", surface, "enter"]);
			await waitForPredicate(
				() => customs(env, "jev_auto_route_v1").length > 0,
				"owned revocation outcome",
			);
			const receipt = customs(env, "jev_auto_route_v1").at(-1).data;
			assert.equal(receipt.owned, true);
			assert.equal(receipt.recorded, true);
			assert.equal(
				receipt.phase,
				policy === "parent" ? "fallback-attempted" : "held",
			);
			assert.equal(results(env).length, 0);
			assert.equal(
				readdirSync(env.dir, { recursive: true }).some((p) =>
					String(p).includes("subagent-scripts/"),
				),
				false,
			);
			if (policy === "parent") {
				await waitEvent(env, "agent_settled", 2);
				assert.match(JSON.stringify(entries(env)), /AUTO_PARENT_case/);
			} else
				assert.equal(
					journal(env).filter((e) => e.kind === "agent_start").length,
					1,
				);
		});
	}

	for (const mode of ["json", "print"] as const) {
		it(`real ${mode} process with persisted session bypasses`, async () => {
			const wrapper = await start();
			const session = journal(env).findLast((e) => e.session).session;
			submitEditorInput(surface, "/quit");
			await waitForScreen(surface, /__TEST_DONE_0__/, 10000);
			const childEnv: NodeJS.ProcessEnv = {
				...routingProcessEnvironment(process.env),
				AUTO_INTEG_ROOT: env.dir,
				TYPESAFE_API_KEY: "offline-jev-token",
			};
			for (const key of Object.keys(childEnv))
				if (
					key.startsWith("PI_SUBAGENT_") ||
					key === "PI_HERDR_AUTO_ROUTING_DISABLED"
				)
					delete childEnv[key];
			const child = spawn(
				"pi",
				[
					"--offline",
					"-ne",
					"-e",
					wrapper,
					"--model",
					"pi-integration/test",
					"--session",
					session,
					...(mode === "json" ? ["--mode", "json"] : ["--print"]),
					TASK,
				],
				{ cwd: env.dir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
			);
			let output = "",
				errors = "";
			child.stdout.on("data", (chunk) => {
				output += chunk;
			});
			child.stderr.on("data", (chunk) => {
				errors += chunk;
			});
			try {
				await waitForPredicate(
					() => child.exitCode !== null,
					`${mode} exit`,
					20000,
				);
				assert.equal(child.exitCode, 0, errors);
				assert.match(output, /AUTO_PARENT_case/);
				assert.equal(calls(env).length, 0);
				assert.equal(results(env).length, 0);
				assert.ok(
					journal(env).some(
						(e) => e.kind === "before-input" && e.mode === mode,
					),
				);
			} finally {
				if (child.exitCode === null) {
					child.kill("SIGTERM");
					await waitForPredicate(
						() => child.signalCode !== null || child.exitCode !== null,
						`${mode} cleanup exit`,
						5000,
					);
				}
			}
		});
	}

	it("separate real RPC: fresh/idle/streaming/abort bypass with truthful host dispositions", async () => {
		// Start/setup the configured real extension, then stop its TUI before
		// launching the independent RPC process in the same isolated project.
		const wrapper = await start({}, false);
		submitEditorInput(surface, "/quit");
		await waitForScreen(surface, /__TEST_DONE_0__/, 10000);
		const rpc = new BypassRpcDriver(env.dir, wrapper);
		try {
			await rpc.command("get_state");
			const begin = rpc.records.length;
			assert.equal(
				(await rpc.command("prompt", { message: TASK })).data.disposition,
				"started",
			);
			await rpc.settled(begin);
			assert.equal(
				(await rpc.command("steer", { message: TASK })).data.disposition,
				"queued",
			);
			assert.equal(
				(await rpc.command("follow_up", { message: TASK })).data.disposition,
				"queued",
			);
			const idleQueue = (await rpc.command("clear_queue")).data;
			assert.deepEqual(idleQueue, { steering: [TASK], followUp: [TASK] });
			const gate = join(env.dir, "rpc-release");
			assert.equal(
				(
					await rpc.command("prompt", {
						message: `INTEGRATION_WAIT_FOR_FILE: ${gate}`,
					})
				).data.disposition,
				"started",
			);
			await waitForPredicate(
				() => getProviderRequests().some((r) => r.lastUser?.includes(gate)),
				"streaming RPC request",
			);
			assert.equal(
				(await rpc.command("steer", { message: TASK })).data.disposition,
				"queued",
			);
			assert.equal(
				(await rpc.command("follow_up", { message: TASK })).data.disposition,
				"queued",
			);
			assert.deepEqual((await rpc.command("clear_queue")).data, {
				steering: [TASK],
				followUp: [TASK],
			});
			await rpc.command("abort");
			assert.equal((await rpc.command("get_state")).data.isStreaming, false);
			writeFileSync(gate, "release aborted server response");
			assert.equal(calls(env).length, 0);
			assert.equal(results(env).length, 0);
			assert.ok(
				journal(env).some(
					(e) =>
						e.kind === "before-input" && e.mode === "rpc" && e.source === "rpc",
				),
			);
		} finally {
			await rpc.close();
		}
	});
});
