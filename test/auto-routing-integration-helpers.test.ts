/** Offline fault tests for T10 lab ownership/environment and RPC I/O only.
 * No Herdr, Pi/native CLI, provider, input handler or routing seam is invoked.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	routingSuiteSkip,
	routingLabEnvironment,
	routingProcessEnvironment,
	replaceEnvironment,
	teardownRoutingLab,
	type OwnedLabServer,
	type LabTeardown,
} from "./integration/auto-routing-lab.ts";
import { BypassRpcDriver } from "./integration/rpc-driver.ts";

const paths = {
	home: "/private/home",
	tmp: "/private/tmp",
	config: "/private/config",
	socket: "/private/socket",
	nativeBin: "/offline/bin",
	nativeLog: "/private/native.json",
};
describe("T10 deterministic environment", () => {
	it("rejects the live flag without running any setup", () => {
		assert.match(
			String(routingSuiteSkip({ HERDR_ENV: "1", PI_TEST_LIVE: "1" })),
			/deterministic-only/,
		);
		assert.equal(routingSuiteSkip({ HERDR_ENV: "1" }), false);
		assert.match(String(routingSuiteSkip({})), /unavailable/);
	});
	it("drops ambient credentials/config/injection while retaining only private fixture state", () => {
		const source: NodeJS.ProcessEnv = {
			PATH: "/cache/node_modules/.bin:/usr/bin",
			TERM: "xterm",
			TYPESAFE_API_KEY: "host-secret",
			ANTHROPIC_AUTH_TOKEN: "host-secret",
			OPENAI_API_KEY: "host-secret",
			HTTPS_PROXY: "host",
			NODE_OPTIONS: "--import host",
			BASH_ENV: "/host",
			PI_CODING_AGENT_DIR: "/host/pi",
			PI_PACKAGE_DIR: "/host/package",
			PI_CODING_AGENT_SESSION_DIR: "/host/sessions",
			PI_TEST_MODEL: "host/live",
			PI_TEST_LIVE: "1",
			FAKE_NATIVE_MODE: "spawn",
		};
		const lab = routingLabEnvironment(source, paths);
		assert.equal(lab.HOME, paths.home);
		assert.equal(lab.PATH, "/offline/bin:/usr/bin");
		assert.equal(lab.PI_OFFLINE, "1");
		assert.equal(lab.PI_TELEMETRY, "0");
		assert.equal(lab.TERM, "xterm");
		for (const key of Object.keys(source).filter(
			(k) => !["PATH", "TERM"].includes(k),
		))
			assert.equal(lab[key], undefined, key);
		const child = routingProcessEnvironment({
			...lab,
			PI_CODING_AGENT_DIR: "/private/test-agent",
			HERDR_PANE_ID: "owned:p1",
			TYPESAFE_API_KEY: "host-secret",
			NODE_OPTIONS: "host",
		});
		assert.equal(child.PI_CODING_AGENT_DIR, "/private/test-agent");
		assert.equal(child.HERDR_PANE_ID, "owned:p1");
		assert.equal(child.TYPESAFE_API_KEY, undefined);
		assert.equal(child.NODE_OPTIONS, undefined);
		const target: NodeJS.ProcessEnv = { oldCredential: "secret" };
		replaceEnvironment(target, lab);
		assert.deepEqual(target, lab);
	});
});

function cleanupFixture(server: OwnedLabServer) {
	const trace: string[] = [];
	const options: LabTeardown = {
		server,
		lab: "/owned/lab",
		rootWorkspaceId: "owned-root",
		closeRoot: (id) => {
			trace.push(`close:${id}`);
		},
		stopServer: () => {
			trace.push("stop");
		},
		waitExit: async (child) => {
			if (child.exitCode === null && child.signalCode === null)
				throw new Error("fixture wait timeout");
		},
		waitLabQuiet: async () => {
			trace.push("quiet");
		},
		removeLab: () => {
			assert.ok(server.exitCode !== null || server.signalCode !== null);
			trace.push("remove");
		},
		restoreEnvironment: () => {
			trace.push("restore");
		},
	};
	return { options, trace };
}
describe("T10 teardown failures", () => {
	it("aggregates stop/wait failures, terminates only the recorded child, restores environment last", async () => {
		let signalCode: NodeJS.Signals | null = null;
		const server: OwnedLabServer = {
			pid: 42,
			exitCode: null,
			get signalCode() {
				return signalCode;
			},
			kill: (signal) => {
				assert.equal(signal, "SIGTERM");
				signalCode = "SIGTERM";
				return true;
			},
		};
		const { options, trace } = cleanupFixture(server);
		options.stopServer = () => {
			trace.push("stop");
			throw new Error("fixture stop failure");
		};
		await assert.rejects(teardownRoutingLab(options), (error) => {
			assert.ok(error instanceof AggregateError);
			assert.deepEqual(
				error.errors.map((e) => e.message),
				["fixture stop failure", "fixture wait timeout"],
			);
			return true;
		});
		assert.deepEqual(trace, [
			"close:owned-root",
			"stop",
			"quiet",
			"remove",
			"restore",
		]);
	});
	it("retains lab on uncertain exit and restores environment despite escalation failure", async () => {
		const signals: string[] = [];
		const server: OwnedLabServer = {
			pid: 42,
			exitCode: null,
			signalCode: null,
			kill: (signal) => {
				signals.push(String(signal));
				return false;
			},
		};
		const { options, trace } = cleanupFixture(server);
		await assert.rejects(teardownRoutingLab(options), (error) => {
			assert.ok(error instanceof AggregateError);
			assert.ok(error.errors.some((e) => /retained lab/.test(e.message)));
			return true;
		});
		assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
		assert.deepEqual(trace, ["close:owned-root", "stop", "restore"]);
	});
	it("handles an already-exited server without CLI calls or signals", async () => {
		const server: OwnedLabServer = {
			pid: 42,
			exitCode: 0,
			signalCode: null,
			kill: () => {
				throw new Error("unrelated signal");
			},
		};
		const { options, trace } = cleanupFixture(server);
		await teardownRoutingLab(options);
		assert.deepEqual(trace, ["quiet", "remove", "restore"]);
	});
	it("cleans a failed spawn without invoking a CLI or signaling an unrecorded PID", async () => {
		const server: OwnedLabServer = {
			pid: undefined,
			exitCode: null,
			signalCode: null,
			kill: () => {
				throw new Error("unowned signal");
			},
		};
		const { options, trace } = cleanupFixture(server);
		options.spawnFailure = new Error("fixture spawn failure");
		options.removeLab = () => {
			trace.push("remove");
		};
		await assert.rejects(teardownRoutingLab(options), AggregateError);
		assert.deepEqual(trace, ["quiet", "remove", "restore"]);
	});
	it("restores environment when quiet check or file removal fails", async () => {
		for (const stage of ["quiet", "remove"] as const) {
			const server: OwnedLabServer = {
				pid: 42,
				exitCode: 0,
				signalCode: null,
				kill: () => false,
			};
			const { options, trace } = cleanupFixture(server);
			if (stage === "quiet")
				options.waitLabQuiet = async () => {
					throw new Error("owned process still live");
				};
			else
				options.removeLab = () => {
					throw new Error("fixture removal failed");
				};
			await assert.rejects(teardownRoutingLab(options), AggregateError);
			assert.equal(trace.at(-1), "restore");
			assert.equal(trace.includes("remove"), false);
		}
	});
});

async function withDriver(
	script: string,
	run: (driver: BypassRpcDriver) => Promise<void>,
	missing = false,
) {
	const root = mkdtempSync("/tmp/jev-t10r-rpc-");
	const child = missing
		? spawn(join(root, "missing-offline-executable"), [], {
				cwd: root,
				env: {},
				stdio: "pipe",
			})
		: spawn(process.execPath, ["-e", script], {
				cwd: root,
				env: {},
				stdio: "pipe",
			});
	const driver = new BypassRpcDriver(root, "unused", child);
	try {
		await run(driver);
	} finally {
		try {
			await driver.close();
		} catch (error) {
			assert.ok(error instanceof AggregateError);
		}
		assert.ok(
			child.exitCode !== null ||
				child.signalCode !== null ||
				child.pid === undefined,
			"owned child confirmed exited before directory removal",
		);
		rmSync(root, { recursive: true, force: true });
	}
}
describe("T10 RPC transport failure handling", () => {
	it("captures asynchronous spawn error in commands, waits and cleanup", async () => {
		await withDriver(
			"",
			async (driver) => {
				await assert.rejects(
					driver.command("get_state"),
					/process error|not running|exited/,
				);
				await assert.rejects(driver.settled(0), /process error|exited/);
				await assert.rejects(driver.close(), AggregateError);
			},
			true,
		);
	});
	it("captures malformed complete stdout without throwing from a data callback", async () => {
		await withDriver(
			"process.stdout.write('not-json\\n'); setInterval(() => {}, 1000)",
			async (driver) => {
				await assert.rejects(
					driver.command("get_state"),
					/malformed stdout JSONL/,
				);
				await assert.rejects(driver.settled(0), /malformed stdout JSONL/);
				await assert.rejects(driver.close(), AggregateError);
			},
		);
	});
	it("captures stdin stream/write errors and still stops the owned process", async () => {
		await withDriver("setInterval(() => {}, 1000)", async (driver) => {
			driver.process.stdin.destroy(new Error("fixture stdin failure"));
			await assert.rejects(driver.command("get_state"), /stdin/);
			await assert.rejects(driver.close(), AggregateError);
		});
	});
	it("captures stdout/stderr stream errors without unhandled error events", async () => {
		for (const stream of ["stdout", "stderr"] as const) {
			await withDriver("setInterval(() => {}, 1000)", async (driver) => {
				driver.process[stream].destroy(new Error(`fixture ${stream} failure`));
				await assert.rejects(driver.settled(0), new RegExp(`${stream} error`));
				await assert.rejects(driver.close(), AggregateError);
			});
		}
	});
	it("reports an unterminated stdout record on close after actual process exit", async () => {
		await withDriver(
			"process.stdout.write('{\\\"tail\\\":true}');",
			async (driver) => {
				await assert.rejects(
					driver.command("get_state"),
					/unterminated stdout JSONL|RPC exited/,
				);
				await assert.rejects(driver.close(), AggregateError);
			},
		);
	});
	it("wakes a pending wait on signal exit instead of waiting for its deadline", async () => {
		await withDriver("setInterval(() => {}, 1000)", async (driver) => {
			const waiting = assert.rejects(
				driver.settled(0),
				/RPC exited.*signal=SIGTERM/,
			);
			driver.process.kill("SIGTERM");
			await waiting;
		});
	});
	it("preserves LF/CRLF framing and U+2028 inside strings in normal responses", async () => {
		await withDriver(
			"let b=''; process.stdin.on('data', chunk => { b+=chunk; let n; while((n=b.indexOf('\\n'))>=0){const r=JSON.parse(b.slice(0,n)); b=b.slice(n+1); process.stdout.write(JSON.stringify({id:r.id,success:true,data:{text:'a\\u2028b'}})+'\\r\\n');}})",
			async (driver) => {
				assert.equal((await driver.command("get_state")).data.text, "a\u2028b");
				await driver.close();
			},
		);
	});
});
