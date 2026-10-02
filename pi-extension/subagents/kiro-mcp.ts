import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	isBoolean,
	isPlainObject,
	isString,
	type JsonObject,
} from "./type-guards.ts";

const MAX_KIRO_MCP_CONFIG_BYTES = 256 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXECUTION_ENVIRONMENT_KEYS = new Set([
	"PATH",
	"PYTHONPATH",
	"PYTHONHOME",
	"PYTHONSTARTUP",
	"NODE_OPTIONS",
	"NODE_PATH",
	"RUBYOPT",
	"PERL5OPT",
	"PERL5LIB",
	"BASH_ENV",
	"ENV",
	"GCONV_PATH",
	"JAVA_TOOL_OPTIONS",
	"JDK_JAVA_OPTIONS",
	"CLASSPATH",
]);
const SERVER_KEYS = new Set([
	"command",
	"args",
	"env",
	"disabled",
	"autoApprove",
]);

export interface KiroMcpServerRecord {
	name: string;
	/** Digest of executable fields and environment key names, never secret values. */
	definitionSha256: string;
}

export interface KiroMcpSelection {
	sourceFile: string;
	servers: KiroMcpServerRecord[];
}

interface NormalizedServer {
	command: string;
	args: string[];
	envKeys: string[];
}

function canonicalJson(value: any): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isPlainObject(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

function digest(value: any): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function stringList(value: any, label: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => !isString(entry)))
		throw new Error(`${label} must be a list of strings.`);
	return [...value];
}

function normalizeServer(name: string, value: any): NormalizedServer {
	if (!isPlainObject(value))
		throw new Error(`Kiro MCP server "${name}" must be an object.`);
	const unknown = Object.keys(value).filter((key) => !SERVER_KEYS.has(key));
	if (unknown.length)
		throw new Error(
			`Kiro MCP server "${name}" has unsupported field(s): ${unknown.join(", ")}.`,
		);
	if (value.disabled !== undefined && !isBoolean(value.disabled))
		throw new Error(`Kiro MCP server "${name}" disabled must be boolean.`);
	if (value.disabled === true)
		throw new Error(`Kiro MCP server "${name}" is disabled.`);
	if (
		!isString(value.command) ||
		!value.command.trim() ||
		value.command.includes("\0")
	)
		throw new Error(
			`Kiro MCP server "${name}" must be a configured stdio command; remote URL servers are not supported.`,
		);
	const args =
		value.args === undefined ? [] : stringList(value.args, `${name}.args`);
	if (args.some((argument) => argument.includes("\0")))
		throw new Error(`${name}.args cannot contain NUL characters.`);
	if (value.env !== undefined && !isPlainObject(value.env))
		throw new Error(`${name}.env must be an object of string values.`);
	const env = value.env ?? {};
	if (
		Object.entries(env).some(
			([key, entry]) =>
				!ENVIRONMENT_KEY.test(key) || !isString(entry) || entry.includes("\0"),
		)
	)
		throw new Error(
			`${name}.env must use portable environment names and NUL-free string values.`,
		);
	const executionKeys = Object.keys(env).filter(
		(key) =>
			EXECUTION_ENVIRONMENT_KEYS.has(key) ||
			key.startsWith("LD_") ||
			key.startsWith("DYLD_") ||
			key.startsWith("PI_") ||
			key.startsWith("HERDR_"),
	);
	if (executionKeys.length)
		throw new Error(
			`${name}.env cannot override process-loader, executable-search, or managed-run settings: ${executionKeys.join(", ")}.`,
		);
	if (value.autoApprove !== undefined)
		stringList(value.autoApprove, `${name}.autoApprove`);
	return {
		command: value.command,
		args,
		envKeys: Object.keys(env).sort(),
	};
}

function readConfig(path: string): JsonObject {
	const sourceFile = resolve(path);
	const before = lstatSync(sourceFile);
	if (before.isSymbolicLink() || !before.isFile())
		throw new Error(
			`Kiro MCP configuration must be a regular file: ${sourceFile}.`,
		);
	let fd: number | undefined;
	let text: string;
	try {
		fd = openSync(sourceFile, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = fstatSync(fd);
		if (
			!opened.isFile() ||
			opened.dev !== before.dev ||
			opened.ino !== before.ino
		)
			throw new Error(
				`Kiro MCP configuration changed while it was opened: ${sourceFile}.`,
			);
		if (opened.size > MAX_KIRO_MCP_CONFIG_BYTES)
			throw new Error(
				`Kiro MCP configuration exceeds ${MAX_KIRO_MCP_CONFIG_BYTES} bytes: ${sourceFile}.`,
			);
		text = readFileSync(fd, "utf8");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	const parsed = JSON.parse(text);
	if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers))
		throw new Error(
			`Kiro MCP configuration has no mcpServers object: ${sourceFile}.`,
		);
	// SAFETY: isPlainObject above establishes a JSON object at the file boundary.
	return parsed.mcpServers as JsonObject;
}

export function defaultKiroMcpConfigFile(): string {
	return join(homedir(), ".kiro", "settings", "mcp.json");
}

/** Resolve selected personal servers before Herdr creates any resource. */
export function resolveKiroMcpSelection(
	names: readonly string[],
	options: { sourceFile?: string } = {},
): KiroMcpSelection | undefined {
	if (!names.length) return undefined;
	const sourceFile = resolve(options.sourceFile ?? defaultKiroMcpConfigFile());
	const configured = readConfig(sourceFile);
	const servers = names.map((name): KiroMcpServerRecord => {
		if (!Object.hasOwn(configured, name))
			throw new Error(
				`Kiro MCP server "${name}" is not present in ${sourceFile}.`,
			);
		const normalized = normalizeServer(name, configured[name]);
		return {
			name,
			definitionSha256: digest(normalized),
		};
	});
	return { sourceFile, servers };
}

/** Validate marker data without reading the live personal configuration. */
export function kiroMcpSelectionNames(value: any): string[] {
	if (
		!isPlainObject(value) ||
		!isString(value.sourceFile) ||
		!isAbsolute(value.sourceFile) ||
		!Array.isArray(value.servers) ||
		value.servers.length === 0 ||
		value.servers.some(
			(server) =>
				!isPlainObject(server) ||
				!isString(server.name) ||
				!isString(server.definitionSha256) ||
				!SHA256_HEX.test(server.definitionSha256),
		)
	)
		throw new Error("the recorded Kiro MCP selection is malformed");
	const names = value.servers.map((server: KiroMcpServerRecord) => server.name);
	if (new Set(names).size !== names.length)
		throw new Error("the recorded Kiro MCP selection contains duplicate names");
	return names;
}

/** Re-resolve a recorded grant and fail when executable capability drifted. */
export function revalidateKiroMcpSelection(
	recorded: KiroMcpSelection,
): KiroMcpSelection {
	const names = kiroMcpSelectionNames(recorded);
	const current = resolveKiroMcpSelection(names, {
		sourceFile: recorded.sourceFile,
	});
	if (!current)
		throw new Error("the recorded Kiro MCP selection is unexpectedly empty");
	for (let index = 0; index < recorded.servers.length; index++) {
		const before = recorded.servers[index];
		const now = current.servers[index];
		if (before.definitionSha256 !== now.definitionSha256)
			throw new Error(
				`Kiro MCP server "${before.name}" changed after the session was created`,
			);
	}
	return current;
}
