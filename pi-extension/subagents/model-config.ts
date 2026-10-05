import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	findDuplicateAutoRoutingMember,
	findDuplicateJevRouterMember,
} from "./auto-routing-json.ts";
import { getSubagentsConfigPath } from "./config-path.ts";
import { isPlainObject, isString } from "./type-guards.ts";

export const TASK_CATEGORIES = [
	"coding",
	"review",
	"recon",
	"qa",
	"architecture",
	"docs",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];
export const TASK_CATEGORY_DESCRIPTIONS = {
	coding: "Implementation workers",
	review: "Code reviewers",
	recon: "Reconnaissance scouts",
	qa: "Software and test runners",
	architecture: "Planning and diagnosis",
	docs: "Documentation workers",
} satisfies Record<TaskCategory, string>;
export type TaskPreferences = Partial<Record<TaskCategory, string[]>>;
export interface TaskPreferencesMeta {
	generatedAt: string;
	method: "research" | "registry-only";
}

/** Native CLI harnesses whose model IDs never share Pi's provider/model namespace. */
export const NATIVE_MODEL_HARNESSES = ["claude", "kiro"] as const;
export type NativeModelHarness = (typeof NATIVE_MODEL_HARNESSES)[number];
/** One native CLI model ID (for example `opus` or `claude-sonnet-4.5`). */
export const NATIVE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,199}$/;
export type NativeTaskPreferences = Partial<
	Record<NativeModelHarness, TaskPreferences>
>;

export function isNativeModelHarness(value: any): value is NativeModelHarness {
	return value === "claude" || value === "kiro";
}

export interface ModelConfig {
	default?: string;
	agents: Record<string, string>;
	tasks?: TaskPreferences;
	tasksMeta?: TaskPreferencesMeta;
	/**
	 * Ordered native CLI model IDs per harness and task category. These are
	 * passed to the native `--model` flag and never resolved through Pi.
	 */
	native?: NativeTaskPreferences;
}

function invalidModelConfig(source: string, message: string): never {
	throw new Error(`Invalid subagent model config in ${source}: ${message}`);
}

function rejectTaskReference(
	value: string,
	field: string,
	source: string,
): void {
	if (value.trim().toLowerCase().startsWith("task:")) {
		invalidModelConfig(
			source,
			`${field} cannot use task: references; task: references are only valid in the subagent tool's model parameter`,
		);
	}
}

function parseTasks(
	value: any,
	source: string,
	field = "models.tasks",
	validateCandidate?: (candidate: string, path: string) => void,
): TaskPreferences | undefined {
	if (value == null) return undefined;
	if (!isPlainObject(value))
		invalidModelConfig(source, `${field} must be an object`);
	const keys = Object.keys(value);
	if (keys.length === 0) return undefined;
	const unsupported = keys.filter(
		// SAFETY: this check only compares strings against the fixed category set.
		(key) => !TASK_CATEGORIES.includes(key as TaskCategory),
	);
	if (unsupported.length > 0) {
		invalidModelConfig(
			source,
			`${field}.${unsupported[0]} is unsupported; supported categories: ${TASK_CATEGORIES.join(", ")}`,
		);
	}
	const tasks: TaskPreferences = {};
	for (const category of TASK_CATEGORIES) {
		if (!Object.hasOwn(value, category)) continue;
		const candidates = value[category];
		if (!Array.isArray(candidates) || candidates.length === 0) {
			invalidModelConfig(
				source,
				`${field}.${category} must be a non-empty list`,
			);
		}
		const seen = new Set<string>();
		tasks[category] = candidates.map((candidate, index) => {
			if (!isString(candidate) || candidate.trim() === "") {
				invalidModelConfig(
					source,
					`${field}.${category}[${index}] must be a non-empty string`,
				);
			}
			const reference = candidate.trim();
			if (seen.has(reference)) {
				invalidModelConfig(
					source,
					`${field}.${category} has duplicate candidate ${JSON.stringify(reference)}`,
				);
			}
			validateCandidate?.(reference, `${field}.${category}[${index}]`);
			seen.add(reference);
			return reference;
		});
	}
	return tasks;
}

function parseTasksMeta(
	value: any,
	source: string,
): TaskPreferencesMeta | undefined {
	if (value == null) return undefined;
	if (!isPlainObject(value))
		invalidModelConfig(source, "models.tasksMeta must be an object");
	const unsupported = Object.keys(value).filter(
		(key) => key !== "generatedAt" && key !== "method",
	);
	if (unsupported.length > 0) {
		invalidModelConfig(
			source,
			`models.tasksMeta has unsupported key(s): ${unsupported.join(", ")}`,
		);
	}
	if (
		!isString(value.generatedAt) ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
			value.generatedAt,
		) ||
		Number.isNaN(Date.parse(value.generatedAt))
	) {
		invalidModelConfig(
			source,
			"models.tasksMeta.generatedAt must be an ISO-8601 string",
		);
	}
	if (value.method !== "research" && value.method !== "registry-only") {
		invalidModelConfig(
			source,
			'models.tasksMeta.method must be "research" or "registry-only"',
		);
	}
	return { generatedAt: value.generatedAt, method: value.method };
}

/**
 * Parse `models.native.<harness>.tasks`. Candidates are native CLI model IDs,
 * validated syntactically only: the native CLI owns their authentication.
 */
function parseNativeTasks(
	value: any,
	source: string,
): NativeTaskPreferences | undefined {
	if (value == null) return undefined;
	if (!isPlainObject(value))
		invalidModelConfig(source, "models.native must be an object");
	const native: NativeTaskPreferences = {};
	for (const harness of Object.keys(value)) {
		const entry = value[harness];
		if (!isNativeModelHarness(harness))
			invalidModelConfig(
				source,
				`models.native.${harness} is unsupported; supported harnesses: ${NATIVE_MODEL_HARNESSES.join(", ")}`,
			);
		if (!isPlainObject(entry))
			invalidModelConfig(source, `models.native.${harness} must be an object`);
		const unsupported = Object.keys(entry).filter((key) => key !== "tasks");
		if (unsupported.length > 0)
			invalidModelConfig(
				source,
				`models.native.${harness} has unsupported key(s): ${unsupported.join(", ")}`,
			);
		const tasks = parseTasks(
			entry.tasks,
			source,
			`models.native.${harness}.tasks`,
			(candidate, path) => {
				rejectTaskReference(candidate, path, source);
				if (candidate.includes(",") || !NATIVE_MODEL_ID.test(candidate))
					invalidModelConfig(
						source,
						`${path} must be one native CLI model ID, not ${JSON.stringify(candidate)}`,
					);
			},
		);
		if (tasks) native[harness] = tasks;
	}
	return Object.keys(native).length > 0 ? native : undefined;
}

export function parseModelConfig(
	rawConfig: any,
	source = "config.json",
): ModelConfig {
	if (!isPlainObject(rawConfig))
		invalidModelConfig(source, "root must be an object");
	const models = rawConfig.models;
	if (models == null) return { agents: {} };
	if (!isPlainObject(models))
		invalidModelConfig(source, "models must be an object");
	const allowedKeys = new Set([
		"default",
		"agents",
		"tasks",
		"tasksMeta",
		"native",
	]);
	const unsupportedKeys = Object.keys(models).filter(
		(key) => !allowedKeys.has(key),
	);
	if (unsupportedKeys.length > 0)
		invalidModelConfig(
			source,
			`models has unsupported key(s): ${unsupportedKeys.join(", ")}`,
		);

	let defaultModel: string | undefined;
	if (models.default != null) {
		if (!isString(models.default) || models.default.trim() === "")
			invalidModelConfig(source, "models.default must be a non-empty string");
		const trimmedDefault = models.default.trim();
		defaultModel = trimmedDefault;
		rejectTaskReference(trimmedDefault, "models.default", source);
	}
	const agents: Record<string, string> = {};
	if (models.agents != null) {
		if (!isPlainObject(models.agents))
			invalidModelConfig(source, "models.agents must be an object");
		for (const [agent, model] of Object.entries(models.agents)) {
			if (!isString(model) || model.trim() === "")
				invalidModelConfig(
					source,
					`models.agents.${agent} must be a non-empty string`,
				);
			const trimmed = model.trim();
			rejectTaskReference(trimmed, `models.agents.${agent}`, source);
			Object.defineProperty(agents, agent, {
				value: trimmed,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}
	const tasks = parseTasks(models.tasks, source);
	const tasksMeta = parseTasksMeta(models.tasksMeta, source);
	const native = parseNativeTasks(models.native, source);
	const config: ModelConfig = { agents };
	if (defaultModel) config.default = defaultModel;
	if (tasks) config.tasks = tasks;
	if (tasksMeta) config.tasksMeta = tasksMeta;
	if (native) config.native = native;
	return config;
}

export function resolveModelDefault(
	agentName: string | undefined,
	agentModel: string | undefined,
	config: ModelConfig,
): string | undefined {
	if (agentModel) return agentModel;
	if (agentName && Object.hasOwn(config.agents, agentName))
		return config.agents[agentName];
	return config.default;
}

export function loadModelConfig(
	configPath = getSubagentsConfigPath(),
): ModelConfig {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (error) {
		// SAFETY: readFileSync errors expose the Node errno code.
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { agents: {} };
		throw error;
	}
	try {
		return parseModelConfig(JSON.parse(raw), configPath);
	} catch (error) {
		if (error instanceof SyntaxError)
			throw new Error(
				`Invalid JSON in subagent model config ${configPath}: ${error.message}`,
			);
		throw error;
	}
}

export interface SavedTaskModelConfig {
	configPath: string;
	tasks: TaskPreferences;
	tasksMeta: TaskPreferencesMeta | undefined;
	missingCategories: TaskCategory[];
}

/** Atomically replace task preferences; refuse ambiguous autoRouting before rewriting. */
export function writeTaskModelConfig(
	configPath: string,
	examplePath: string,
	tasks: TaskPreferences,
	tasksMeta: TaskPreferencesMeta,
	isAuthenticatedCandidate: (candidate: string) => boolean,
	fileOperations: Pick<
		typeof import("node:fs"),
		"renameSync" | "writeFileSync"
	> = { renameSync, writeFileSync },
): SavedTaskModelConfig {
	const candidateConfig = parseModelConfig(
		{ models: { tasks, tasksMeta } },
		configPath,
	);
	for (const candidates of Object.values(candidateConfig.tasks ?? {})) {
		for (const candidate of candidates) {
			if (!isAuthenticatedCandidate(candidate)) {
				throw new Error(
					`Task model candidate ${JSON.stringify(candidate)} is not an authenticated exact registry model`,
				);
			}
		}
	}
	const current = readFileIfExists(configPath);
	const sourcePath = current == null ? examplePath : configPath;
	const source = current ?? readFileSync(examplePath, "utf8");
	let parsed: any;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		throw new Error(
			`Invalid JSON in subagent config ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	// Inspect the original accepted JSON text before last-member-wins parsing
	// can be normalized into a different routing authorization on disk.
	let duplicate: string | undefined;
	try {
		duplicate = findDuplicateAutoRoutingMember(source);
	} catch (error) {
		throw new Error(
			`Cannot check subagent auto-routing config in ${sourcePath} for duplicate JSON members: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (duplicate !== undefined)
		throw new Error(
			`Invalid subagent auto-routing config in ${sourcePath}: ${duplicate} is a duplicate JSON member`,
		);
	try {
		duplicate = findDuplicateJevRouterMember(source);
	} catch (error) {
		throw new Error(
			`Cannot check subagent jevRouter config in ${sourcePath} for duplicate JSON members: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (duplicate !== undefined)
		throw new Error(
			`Invalid subagent jevRouter config in ${sourcePath}: ${duplicate} is a duplicate JSON member`,
		);
	if (!isPlainObject(parsed))
		throw new Error(
			`Invalid JSON in subagent config ${configPath}: root must be an object`,
		);
	const models = isPlainObject(parsed.models) ? { ...parsed.models } : {};
	models.tasks = candidateConfig.tasks;
	models.tasksMeta = candidateConfig.tasksMeta;
	const output = JSON.stringify({ ...parsed, models }, null, 2) + "\n";
	mkdirSync(dirname(configPath), { recursive: true });
	const temporary = join(
		dirname(configPath),
		`.${Date.now()}-${process.pid}-config.tmp`,
	);
	fileOperations.writeFileSync(temporary, output, { flag: "wx" });
	fileOperations.renameSync(temporary, configPath);
	return {
		configPath,
		tasks: candidateConfig.tasks ?? {},
		tasksMeta: candidateConfig.tasksMeta,
		missingCategories: TASK_CATEGORIES.filter(
			(category) => !candidateConfig.tasks?.[category],
		),
	};
}

function readFileIfExists(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		// SAFETY: readFileSync errors expose the Node errno code.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
