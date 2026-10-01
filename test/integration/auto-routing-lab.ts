/** Deterministic-only environment and owned-process teardown helpers.
 * Importing this module creates no resources and contacts no service.
 */
import type { ChildProcess } from "node:child_process";

const SHELL_KEYS = [
	"PATH",
	"TERM",
	"COLORTERM",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"USER",
	"LOGNAME",
	"PI_TEST_TIMEOUT",
];
const PRIVATE_PROCESS_KEYS = [
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"TMPDIR",
	"HERDR_CONFIG_PATH",
	"HERDR_SOCKET_PATH",
	"HERDR_WORKSPACE_ID",
	"HERDR_PANE_ID",
	"HERDR_TAB_ID",
	"PI_CODING_AGENT_DIR",
	"FAKE_NATIVE_LOG",
	"AUTO_INTEG_ROOT",
];

export function routingSuiteSkip(env: NodeJS.ProcessEnv): string | false {
	if (env.PI_TEST_LIVE === "1")
		return "T10 is deterministic-only; live mode is not supported";
	return env.HERDR_ENV === "1" ? false : "Herdr is unavailable";
}
function pickEnvironment(
	source: NodeJS.ProcessEnv,
	keys: readonly string[],
): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const key of keys)
		if (source[key] !== undefined) result[key] = source[key];
	return result;
}
export interface RoutingLabPaths {
	home: string;
	tmp: string;
	config: string;
	socket: string;
	nativeBin: string;
	nativeLog: string;
}
export function routingLabEnvironment(
	source: NodeJS.ProcessEnv,
	paths: RoutingLabPaths,
): NodeJS.ProcessEnv {
	return {
		...pickEnvironment(source, SHELL_KEYS),
		HOME: paths.home,
		XDG_CONFIG_HOME: `${paths.home}/.config`,
		XDG_DATA_HOME: `${paths.home}/.local/share`,
		XDG_STATE_HOME: `${paths.home}/.local/state`,
		TMPDIR: paths.tmp,
		HERDR_CONFIG_PATH: paths.config,
		HERDR_SOCKET_PATH: paths.socket,
		HERDR_ENV: "1",
		// npm may prepend an obsolete development Pi CLI. New shells must
		// resolve installed Pi and offline native fixtures, not that CLI.
		PATH: `${paths.nativeBin}:${
			source.PATH?.split(":")
				.filter((p) => !p.includes("node_modules/.bin"))
				.join(":") ?? ""
		}`,
		SHELL: "/bin/bash",
		FAKE_NATIVE_LOG: paths.nativeLog,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
	};
}
/** Call only after lab setup; keep fixture agent-home/IDs, never credentials,
 * NODE/BASH injection, proxies or ambient provider/package/session overrides. */
export function routingProcessEnvironment(
	source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	return {
		...pickEnvironment(source, [...SHELL_KEYS, ...PRIVATE_PROCESS_KEYS]),
		HERDR_ENV: "1",
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
	};
}
export function replaceEnvironment(
	target: NodeJS.ProcessEnv,
	values: NodeJS.ProcessEnv,
): void {
	for (const key of Object.keys(target)) delete target[key];
	Object.assign(target, values);
}
export type OwnedLabServer = Pick<
	ChildProcess,
	"pid" | "exitCode" | "signalCode" | "kill"
>;
export function serverExited(
	server: OwnedLabServer,
	spawnFailed = false,
): boolean {
	return (
		server.exitCode !== null ||
		server.signalCode !== null ||
		(server.pid === undefined && spawnFailed)
	);
}
export interface LabTeardown {
	server?: OwnedLabServer;
	spawnFailure?: Error;
	lab?: string;
	rootWorkspaceId?: string;
	closeRoot(id: string): void;
	stopServer(): void;
	waitExit(server: OwnedLabServer): Promise<void>;
	waitLabQuiet(lab: string): Promise<void>;
	removeLab(lab: string): void;
	restoreEnvironment(): void;
}
/** Never signals discovered PIDs. Only the recorded spawned child may be
 * terminated; uncertain exit or live lab processes retain the directory. */
export async function teardownRoutingLab(options: LabTeardown): Promise<void> {
	const errors: Error[] = [];
	const capture = (error: any) =>
		errors.push(error instanceof Error ? error : new Error(String(error)));
	const server = options.server;
	const exited = () => !server || serverExited(server, !!options.spawnFailure);
	try {
		if (options.spawnFailure) capture(options.spawnFailure);
		if (server && !exited()) {
			if (options.rootWorkspaceId) {
				try {
					options.closeRoot(options.rootWorkspaceId);
				} catch (error) {
					capture(error);
				}
			}
			try {
				options.stopServer();
			} catch (error) {
				capture(error);
			}
			if (!exited()) {
				try {
					await options.waitExit(server);
				} catch (error) {
					capture(error);
				}
			}
			for (const signal of ["SIGTERM", "SIGKILL"] as const) {
				if (exited()) break;
				if (server.pid === undefined) {
					capture(new Error("Unconfirmed server identity; refusing to signal"));
					break;
				}
				try {
					if (!server.kill(signal))
						capture(new Error(`Owned server refused ${signal}`));
				} catch (error) {
					capture(error);
				}
				if (!exited()) {
					try {
						await options.waitExit(server);
					} catch (error) {
						capture(error);
					}
				}
			}
		}
		if (options.lab) {
			if (!exited())
				capture(
					new Error(`Server exit unconfirmed; retained lab ${options.lab}`),
				);
			else {
				try {
					await options.waitLabQuiet(options.lab);
					options.removeLab(options.lab);
				} catch (error) {
					capture(error);
				}
			}
		}
	} finally {
		try {
			options.restoreEnvironment();
		} catch (error) {
			capture(error);
		}
	}
	if (errors.length)
		throw new AggregateError(errors, "Automatic-routing lab teardown failed");
}
