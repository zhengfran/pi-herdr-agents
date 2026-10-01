/** Real subprocess RPC driver, used only to prove non-TUI bypass. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { waitForPredicate } from "./harness.ts";
import { routingProcessEnvironment } from "./auto-routing-lab.ts";

interface BypassCommandData {
	message?: string;
	streamingBehavior?: "steer" | "followUp";
}

export class BypassRpcDriver {
	readonly process: ChildProcessWithoutNullStreams;
	readonly records: any[] = [];
	stderr = "";
	private sequence = 0;
	private readonly failures: Error[] = [];
	private streamsClosed = false;
	/** An already spawned offline child is allowed for driver fault tests only;
	 * real bypass evidence always uses the normal installed Pi process. */
	constructor(
		cwd: string,
		extension: string,
		child?: ChildProcessWithoutNullStreams,
	) {
		const env: NodeJS.ProcessEnv = {
			...routingProcessEnvironment(process.env),
			AUTO_INTEG_ROOT: cwd,
			TYPESAFE_API_KEY: "offline-jev-token",
		};
		this.process =
			child ??
			spawn(
				"pi",
				[
					"--offline",
					"--mode",
					"rpc",
					"-ne",
					"-e",
					extension,
					"--model",
					"pi-integration/test",
					"--no-skills",
					"--no-prompt-templates",
					"--no-context-files",
					"--approve",
				],
				{ cwd, env, stdio: "pipe" },
			);
		this.process.on("error", (error) => this.fail("process error", error));
		this.process.on("close", () => {
			this.streamsClosed = true;
		});
		this.process.stdin.on("error", (error) => this.fail("stdin error", error));
		this.process.stdout.on("error", (error) =>
			this.fail("stdout error", error),
		);
		this.process.stderr.on("error", (error) =>
			this.fail("stderr error", error),
		);
		let buffer = "";
		this.process.stdout.setEncoding("utf8");
		this.process.stdout.on("data", (chunk) => {
			buffer += chunk;
			let end: number;
			while ((end = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, end).replace(/\r$/, "");
				buffer = buffer.slice(end + 1);
				if (line.trim()) {
					try {
						this.records.push(JSON.parse(line));
					} catch (error) {
						this.fail("malformed stdout JSONL", error);
					}
				}
			}
		});
		this.process.stdout.on("end", () => {
			if (buffer.trim())
				this.fail(
					"unterminated stdout JSONL",
					new Error("Missing terminating LF"),
				);
		});
		this.process.stderr.setEncoding("utf8");
		this.process.stderr.on("data", (chunk) => {
			this.stderr = (this.stderr + chunk).slice(-8192);
		});
	}
	private fail(label: string, error: any): void {
		this.failures.push(
			new Error(
				`RPC ${label}: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
	}
	private exited(): boolean {
		return (
			this.process.exitCode !== null ||
			this.process.signalCode !== null ||
			(this.process.pid === undefined && this.failures.length > 0)
		);
	}
	private diagnostic(label: string): Error {
		return new Error(
			`${label}; exit=${this.process.exitCode}; signal=${this.process.signalCode}; stderr=${this.stderr}; failures=${this.failures.map((e) => e.message).join("; ")}`,
		);
	}
	private checkFailure(): void {
		if (this.failures.length) throw this.diagnostic("RPC transport failed");
	}
	private async wait(
		check: () => boolean,
		label: string,
		timeout = 30000,
	): Promise<void> {
		this.checkFailure();
		await waitForPredicate(
			() => check() || this.exited() || this.failures.length > 0,
			label,
			timeout,
		).catch((error) => {
			throw this.diagnostic(String(error));
		});
		this.checkFailure();
		if (!check()) throw this.diagnostic(`RPC exited before ${label}`);
	}
	async command(type: string, data: BypassCommandData = {}) {
		this.checkFailure();
		if (this.exited()) throw this.diagnostic("RPC is not running");
		const id = `bypass-${++this.sequence}`;
		let written = false;
		try {
			this.process.stdin.write(
				JSON.stringify({ id, type, ...data }) + "\n",
				(error) => {
					if (error) this.fail("stdin write", error);
					written = true;
				},
			);
		} catch (error) {
			this.fail("stdin write", error);
		}
		await this.wait(() => written, `RPC ${type} write`);
		await this.wait(
			() => this.records.some((r) => r?.id === id),
			`RPC ${type} response`,
		);
		const response = this.records.find((r) => r?.id === id);
		if (!response.success)
			throw this.diagnostic(
				`RPC rejected command: ${JSON.stringify(response)}`,
			);
		return response;
	}
	async settled(since: number) {
		await this.wait(
			() => this.records.slice(since).some((r) => r?.type === "agent_settled"),
			"RPC agent_settled",
		);
	}
	async close() {
		const cleanupErrors: Error[] = [];
		if (!this.exited()) {
			try {
				// Writable.end's callback has no error argument; the permanent
				// stdin error listener captures asynchronous failures.
				this.process.stdin.end();
			} catch (error) {
				this.fail("stdin end", error);
			}
			try {
				await waitForPredicate(
					() => this.exited() || this.failures.length > 0,
					"RPC orderly exit",
					10000,
				);
			} catch (error) {
				cleanupErrors.push(this.diagnostic(String(error)));
			}
			for (const signal of ["SIGTERM", "SIGKILL"] as const) {
				if (this.exited()) break;
				if (this.process.pid === undefined) {
					cleanupErrors.push(
						this.diagnostic(
							"Unconfirmed RPC process identity; refusing to signal",
						),
					);
					break;
				}
				try {
					if (!this.process.kill(signal))
						cleanupErrors.push(this.diagnostic(`RPC refused ${signal}`));
				} catch (error) {
					cleanupErrors.push(this.diagnostic(String(error)));
				}
				try {
					await waitForPredicate(
						() => this.exited(),
						`RPC ${signal} exit`,
						5000,
					);
				} catch (error) {
					cleanupErrors.push(this.diagnostic(String(error)));
				}
			}
		}
		if (!this.exited())
			cleanupErrors.push(this.diagnostic("RPC exit unconfirmed"));
		else {
			// Exit can precede final stdout/end events. Capture a malformed tail
			// before reporting cleanup success, including failed-spawn close.
			try {
				await waitForPredicate(
					() => this.streamsClosed,
					"RPC stdio close",
					5000,
				);
			} catch (error) {
				cleanupErrors.push(this.diagnostic(String(error)));
			}
		}
		if (this.process.exitCode !== null && this.process.exitCode !== 0)
			cleanupErrors.push(this.diagnostic("RPC nonzero exit"));
		const errors = [...this.failures, ...cleanupErrors];
		if (errors.length)
			throw new AggregateError(
				errors,
				this.diagnostic("RPC cleanup failed").message,
			);
	}
}
