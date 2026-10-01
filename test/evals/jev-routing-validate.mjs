import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_AUTO_ROUTING_THRESHOLDS } from "../../pi-extension/subagents/auto-routing-config.ts";
import { NATIVE_MODEL_ID } from "../../pi-extension/subagents/model-config.ts";
import {
	autoEffortBand,
	decideAfterBatchA,
	decideAfterBatchB,
	validateJevEvidence,
} from "../../pi-extension/subagents/auto-routing-policy.ts";
import {
	buildBatchA,
	buildBatchB,
} from "../../pi-extension/subagents/jev-questions.ts";
import {
	isBoolean,
	isFiniteNumber,
	isPlainObject,
	isString,
} from "../../pi-extension/subagents/type-guards.ts";

export const VERSIONS = Object.freeze({
	pin: "jev-1.13.0",
	policy: "jev-auto-v1",
	questions: "jev-auto-questions-v1",
	catalog: "jev-routing-catalog-synthetic-v1",
	cases: "jev-routing-cases-synthetic-v1",
	answers: "jev-routing-answers-synthetic-v1",
});
const tiers = ["fast", "mid", "frontier"];
const kinds = ["route", "abstain", "bypass", "unknown"];
const tupleKeys = "id roleId harness model effort tier family";
const boolGates = [
	"enabled",
	"apis",
	"persisted",
	"herdr",
	"child",
	"idle",
	"pending",
];

function check(condition, message) {
	if (!condition) throw new Error(message);
}
function keys(value, fields, label) {
	check(isPlainObject(value), `${label}: object required`);
	const expected = fields.split(" ");
	check(
		Object.keys(value).length === expected.length &&
			expected.every((key) => Object.hasOwn(value, key)),
		`${label}: unknown/missing keys`,
	);
	check(
		Object.keys(value).every(
			(key) =>
				expected.includes(key) &&
				!["__proto__", "constructor", "prototype"].includes(key),
		),
		`${label}: reserved keys`,
	);
}
function text(value, label, max = 4096) {
	check(
		isString(value) &&
			value.length > 0 &&
			Buffer.byteLength(value) <= max &&
			!Array.from(value).some((char) => {
				const code = char.charCodeAt(0);
				return (
					code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31)
				);
			}),
		`${label}: bounded text required`,
	);
}
function integer(value, label, max) {
	check(
		Number.isSafeInteger(value) && value >= 0 && value <= max,
		`${label}: integer out of range`,
	);
}
function number(value, label, max = 1e9) {
	check(
		isFiniteNumber(value) && value >= 0 && value <= max,
		`${label}: number out of range`,
	);
}
function list(value, label, max = 256) {
	check(
		Array.isArray(value) && value.length <= max,
		`${label}: bounded array required`,
	);
}
function strings(value, label, max = 256) {
	list(value, label, max);
	value.forEach((entry) => text(entry, label, 128));
	check(new Set(value).size === value.length, `${label}: duplicate values`);
}
function one(value, options, label) {
	check(options.includes(value), `${label}: unsupported value`);
}
function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isPlainObject(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
export function digest(value) {
	return createHash("sha256").update(canonical(value)).digest("hex");
}
function validateTuple(tuple, label) {
	keys(tuple, tupleKeys, label);
	for (const field of ["id", "roleId", "model", "family"])
		text(tuple[field], `${label}.${field}`, 200);
	check(
		/^c\d{3}$/.test(tuple.id) && /^r\d{2}$/.test(tuple.roleId),
		`${label}: opaque IDs required`,
	);
	one(tuple.harness, ["pi", "claude", "kiro"], label);
	one(
		tuple.effort,
		["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		label,
	);
	one(tuple.tier, tiers, label);
	check(
		autoEffortBand(tuple.harness, tuple.effort) !== undefined,
		`${label}: unsupported effort`,
	);
	check(
		tuple.harness !== "pi" || /^[a-z0-9-]+\/[a-z0-9.-]+$/.test(tuple.model),
		`${label}: exact Pi ref required`,
	);
	check(
		tuple.harness === "pi" || NATIVE_MODEL_ID.test(tuple.model),
		`${label}: exact native ID syntax required`,
	);
	check(
		!/(latest|default|auto|task:|\*)/i.test(tuple.model) &&
			/\d/.test(tuple.model),
		`${label}: versioned synthetic model required`,
	);
}
export function snapshotFor(catalog, entry, decisionId) {
	return {
		decisionId,
		snapshotHash: digest(catalog),
		task: entry.task,
		policyVersion: VERSIONS.policy,
		questionVersion: VERSIONS.questions,
		roles: catalog.roles.map((role) => ({
			id: role.id,
			approval: {
				agent: role.agent,
				intent: role.intent,
				purpose: role.purpose,
				responsibility: role.responsibility,
				deliverable: role.deliverable,
				excludes: role.excludes,
			},
			role: {},
			roleFingerprint: digest(role),
		})),
		candidates: catalog.tuples.map((tuple, preference) => ({
			id: tuple.id,
			roleId: tuple.roleId,
			harness: tuple.harness,
			exactModel:
				tuple.harness === "pi"
					? {
							namespace: "pi",
							provider: tuple.model.split("/")[0],
							id: tuple.model.split("/")[1],
							ref: tuple.model,
						}
					: { namespace: tuple.harness, id: tuple.model },
			exactEffort: tuple.effort,
			tier: tuple.tier,
			roleFingerprint: digest(
				catalog.roles.find((role) => role.id === tuple.roleId),
			),
			profile: {
				preference,
				taskStrengths:
					"Synthetic reviewed profile; suitable within assigned tier.",
				limitations: "Offline fictional tuple; no access or quality claim.",
			},
		})),
	};
}

/** Public handler-visible view only. This is not a host/lifecycle simulator. */
export function viewBypass(entry) {
	const v = entry.view;
	if (!v.enabled) return "routing-off";
	if (!v.apis) return "unsupported-public-api";
	if (v.mode !== "tui") return "unsupported-session-mode";
	if (v.source !== "interactive") return "non-interactive-source";
	if (v.streaming !== null) return "not-fresh-prompt";
	if (v.child) return "child-session";
	if (!v.idle || v.pending) return "parent-busy";
	if (v.images > 0) return "image-input";
	if (!entry.task.trim()) return "blank-prompt";
	if (/^\s*[/!]/u.test(entry.task)) return "command-input";
	if (entry.task.includes("[no-auto-route]")) return "user-opt-out";
	if (!v.persisted) return "no-session-file";
	if (!v.herdr) return "herdr-unavailable";
	return null;
}

/** Construct only the public Pi adapter result, never repair the wire. */
function adapterResult(wire) {
	const answers = {};
	for (const [id, answer] of Object.entries(wire.answers ?? {})) {
		answers[id] =
			answer.type === "score"
				? { type: "score", score: answer.score, confidence: answer.confidence }
				: answer.type === "noul"
					? { type: "bool", probability: answer.noul }
					: { ...answer };
	}
	const input = wire.usage?.input_tokens;
	const output = wire.usage?.output_tokens;
	return {
		api: "typesafe-system-one",
		provider: "typesafe",
		model: VERSIONS.pin,
		answers,
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}
export function evidenceFor(batch, wire) {
	const decoded = validateJevEvidence(batch, {
		wire,
		result: adapterResult(wire),
	});
	check(decoded.ok, `evidence: ${decoded.detail}`);
	return decoded.evidence;
}
function batchOf(built) {
	check(built.ok, `batch bounds: ${built.detail}`);
	return built.batch;
}
/** Replay the actual pinned combination policy using complete distributions. */
export function replay(catalog, entry, record) {
	const bypass = viewBypass(entry);
	if (bypass) {
		check(
			record.batches.A === null && record.batches.B === null,
			"bypass must have zero classifier batches",
		);
		return {
			kind: "bypass",
			reason: bypass,
			candidateId: null,
			requiredBand: null,
		};
	}
	if (entry.scenario === "crash-before-ownership") {
		check(
			record.batches.A === null && record.batches.B === null,
			"pre-ownership crash has no completed evidence",
		);
		return {
			kind: "unknown",
			reason: "crash-before-ownership",
			candidateId: null,
			requiredBand: null,
		};
	}
	check(record.batches.A !== null, "eligible decision missing batch A");
	const snap = snapshotFor(catalog, entry, record.decisionId);
	const a = decideAfterBatchA(
		snap,
		evidenceFor(batchOf(buildBatchA(snap)), record.batches.A.wire),
		DEFAULT_AUTO_ROUTING_THRESHOLDS,
	);
	if (a.kind !== "continue") {
		check(
			record.batches.B === null,
			"batch B forbidden after batch A abstention",
		);
		check(a.kind === "abstain", "unavailable synthetic policy evidence");
		return {
			kind: "abstain",
			reason: a.reason,
			candidateId: null,
			requiredBand: null,
		};
	}
	check(record.batches.B !== null, "eligible selection missing batch B");
	const b = decideAfterBatchB(
		a.plan,
		evidenceFor(batchOf(buildBatchB(a.plan)), record.batches.B.wire),
		DEFAULT_AUTO_ROUTING_THRESHOLDS,
	);
	if (b.kind !== "selected") {
		check(b.kind === "abstain", "unavailable synthetic batch B evidence");
		return {
			kind: "abstain",
			reason: b.reason,
			candidateId: null,
			requiredBand: null,
		};
	}
	if (entry.scenario === "candidate-drift")
		return {
			kind: "abstain",
			reason: "stale-snapshot",
			candidateId: null,
			requiredBand: a.plan.requiredBand,
		};
	if (entry.scenario === "dispatch-unknown")
		return {
			kind: "unknown",
			reason: "dispatch-uncertain",
			candidateId: b.candidate.id,
			requiredBand: a.plan.requiredBand,
		};
	return {
		kind: "route",
		reason: null,
		candidateId: b.candidate.id,
		requiredBand: a.plan.requiredBand,
	};
}

function validateCatalog(catalog) {
	keys(catalog, "version synthetic thresholdsStatus roles tuples", "catalog");
	check(
		catalog.version === VERSIONS.catalog &&
			catalog.synthetic === true &&
			catalog.thresholdsStatus === "uncalibrated",
		"catalog versions/synthetic/uncalibrated required",
	);
	list(catalog.roles, "roles", 16);
	list(catalog.tuples, "tuples", 128);
	check(catalog.roles.length > 0 && catalog.tuples.length > 0, "empty catalog");
	const roleIds = new Set();
	for (const role of catalog.roles) {
		keys(
			role,
			"id agent intent purpose responsibility deliverable excludes",
			"role",
		);
		check(
			/^r\d{2}$/.test(role.id) && !roleIds.has(role.id),
			"duplicate/invalid role ID",
		);
		roleIds.add(role.id);
		for (const field of ["agent", "responsibility", "deliverable", "excludes"])
			text(role[field], field, 256);
		one(role.intent, ["report", "modify"], "role intent");
		one(role.purpose, ["task", "review"], "role purpose");
	}
	const ids = new Set();
	const tuples = new Set();
	for (const tuple of catalog.tuples) {
		validateTuple(tuple, "catalog tuple");
		const identity = canonical([
			tuple.roleId,
			tuple.harness,
			tuple.model,
			tuple.effort,
		]);
		check(
			!ids.has(tuple.id) && !tuples.has(identity),
			"duplicate tuple ID/authorization",
		);
		check(roleIds.has(tuple.roleId), "tuple has unknown role");
		ids.add(tuple.id);
		tuples.add(identity);
	}
	for (const id of roleIds)
		check(
			catalog.tuples.some((tuple) => tuple.roleId === id),
			"role missing authorized tuples",
		);
}
function validateCase(entry, catalog) {
	keys(
		entry,
		"id version language categories task view scenario expected",
		"case",
	);
	text(entry.id, "case ID", 64);
	check(
		/^(tune|heldout)-\d{3}$/.test(entry.id) && entry.version === VERSIONS.cases,
		"case ID/version",
	);
	text(entry.language, "language", 32);
	strings(entry.categories, "categories", 16);
	check(entry.categories.length > 0, "categories required");
	// Blank prompts are deliberate current-view bypass fixtures.
	check(
		isString(entry.task) && Buffer.byteLength(entry.task) <= 8192,
		"bounded task required",
	);
	keys(
		entry.view,
		"mode source streaming images enabled apis persisted herdr child idle pending",
		"view",
	);
	one(entry.view.mode, ["tui", "rpc", "json", "print"], "mode");
	one(entry.view.source, ["interactive", "rpc", "extension"], "source");
	one(entry.view.streaming, [null, "steer", "followUp"], "streaming");
	integer(entry.view.images, "images", 16);
	for (const key of boolGates)
		check(isBoolean(entry.view[key]), `view.${key}: boolean required`);
	one(
		entry.scenario,
		["stable", "candidate-drift", "crash-before-ownership", "dispatch-unknown"],
		"scenario",
	);
	const e = entry.expected;
	keys(
		e,
		"kind reason roles tupleIds minBand mutation maxTier independence authorFamily authorization noReplay",
		"expected",
	);
	one(e.kind, kinds, "expected kind");
	if (e.reason !== null) text(e.reason, "expected reason", 80);
	strings(e.roles, "expected roles", 16);
	strings(e.tupleIds, "expected tuple IDs", 128);
	integer(e.minBand, "minimum band", 3);
	one(e.mutation, ["report", "modify", "unspecified"], "mutation");
	one(e.maxTier, [null, ...tiers], "max tier");
	one(
		e.independence,
		[
			"none",
			"strict-known-author",
			"strict-unknown-author",
			"review-provenance-unverified",
		],
		"independence",
	);
	if (e.authorFamily !== null) text(e.authorFamily, "author family", 80);
	check(
		e.authorization === "exact-catalog-only" && e.noReplay === true,
		"authorization/no-replay required",
	);
	check(
		e.roles.every((id) => catalog.roles.some((role) => role.id === id)),
		"expected unknown role",
	);
	check(
		e.tupleIds.every((id) =>
			catalog.tuples.some(
				(tuple) => tuple.id === id && e.roles.includes(tuple.roleId),
			),
		),
		"expected unauthorized tuple",
	);
	if (e.kind === "route")
		check(
			e.reason === null &&
				e.roles.length > 0 &&
				e.tupleIds.length > 0 &&
				e.independence === "none" &&
				e.mutation !== "unspecified",
			"route expectations incomplete",
		);
	else
		check(
			e.reason !== null && e.tupleIds.length === 0,
			"non-route expectations incomplete",
		);
	if (e.independence === "strict-known-author")
		check(e.authorFamily !== null, "known author label missing");
	const bypass = viewBypass(entry);
	check(
		(e.kind === "bypass") === (bypass !== null) &&
			(!bypass || e.reason === bypass),
		"expected current-view bypass mismatch",
	);
}
function validateBatch(batch, label) {
	keys(batch, "wire telemetry", label);
	keys(batch.wire, "model answers usage", "evidence: wire");
	keys(batch.wire.usage, "input_tokens output_tokens", "evidence: usage");
	for (const key of ["input_tokens", "output_tokens"])
		integer(batch.wire.usage[key], `wire.${key}`, 1000000);
	check(
		Buffer.byteLength(JSON.stringify(batch.wire)) <= 65536,
		"wire response exceeds offline bound",
	);
	keys(
		batch.telemetry,
		"latencyMs inputTokens outputTokens costUsd",
		"telemetry",
	);
	number(batch.telemetry.latencyMs, "latency", 60000);
	for (const key of ["inputTokens", "outputTokens"])
		if (batch.telemetry[key] !== null)
			integer(batch.telemetry[key], key, 1000000);
	if (batch.telemetry.costUsd !== null)
		number(batch.telemetry.costUsd, "cost", 1000);
	if (batch.telemetry.inputTokens !== null)
		check(
			batch.telemetry.inputTokens === batch.wire.usage?.input_tokens,
			"token telemetry differs from wire",
		);
	if (batch.telemetry.outputTokens !== null)
		check(
			batch.telemetry.outputTokens === batch.wire.usage?.output_tokens,
			"token telemetry differs from wire",
		);
}
export function bindingFor(catalog, entry, split) {
	return {
		pin: VERSIONS.pin,
		policy: VERSIONS.policy,
		questions: VERSIONS.questions,
		catalogVersion: catalog.version,
		catalogSha256: digest(catalog),
		caseVersion: entry.version,
		caseSha256: digest(entry),
		split,
	};
}
function authorized(catalog, tuple) {
	return catalog.tuples.some(
		(allowed) => canonical(allowed) === canonical(tuple),
	);
}

/** Structural/binding errors always throw; semantic violations can be scored. */
export function validateBundle(bundle, { enforceSemantics = true } = {}) {
	keys(bundle, "catalog tune heldout answers", "bundle");
	const { catalog, answers } = bundle;
	validateCatalog(catalog);
	const cases = [];
	const caseIds = new Set();
	const inputSplits = new Map();
	for (const split of ["tune", "heldout"]) {
		keys(bundle[split], "version split cases", split);
		check(
			bundle[split].version === VERSIONS.cases && bundle[split].split === split,
			"split/version mismatch",
		);
		list(bundle[split].cases, "cases", 256);
		for (const entry of bundle[split].cases) {
			validateCase(entry, catalog);
			check(
				entry.id.startsWith(`${split}-`) && !caseIds.has(entry.id),
				"duplicate case ID/split leakage",
			);
			caseIds.add(entry.id);
			const inputHash = digest({
				task: entry.task,
				view: entry.view,
				scenario: entry.scenario,
			});
			check(
				!inputSplits.has(inputHash) || inputSplits.get(inputHash) === split,
				"tune/heldout current-view input leakage",
			);
			inputSplits.set(inputHash, split);
			cases.push({ ...entry, split });
		}
	}
	keys(answers, "version synthetic records", "answers");
	check(
		answers.version === VERSIONS.answers && answers.synthetic === true,
		"answer version/synthetic required",
	);
	list(answers.records, "records", 512);
	check(
		answers.records.length === cases.length,
		"one record per case required",
	);
	const answered = new Set();
	const decisions = new Set();
	const evaluated = [];
	const violations = [];
	for (const record of answers.records) {
		keys(record, "caseId decisionId binding batches host", "record");
		text(record.decisionId, "local decision ID", 80);
		check(
			!answered.has(record.caseId) && !decisions.has(record.decisionId),
			"duplicate case/decision ID",
		);
		answered.add(record.caseId);
		decisions.add(record.decisionId);
		const entry = cases.find((candidate) => candidate.id === record.caseId);
		check(entry, "unknown answer case ID");
		const original = bundle[entry.split].cases.find(
			(candidate) => candidate.id === entry.id,
		);
		keys(
			record.binding,
			"pin policy questions catalogVersion catalogSha256 caseVersion caseSha256 split",
			"binding",
		);
		check(
			canonical(record.binding) ===
				canonical(bindingFor(catalog, original, entry.split)),
			"altered pin/question/policy/catalog/case version or split binding",
		);
		keys(record.batches, "A B", "batches");
		for (const batch of Object.values(record.batches))
			if (batch !== null) validateBatch(batch, "batch");
		const h = record.host;
		keys(
			h,
			"kind reason candidateId tuple requiredBand dispatches dispatchState",
			"host",
		);
		one(h.kind, kinds, "host kind");
		if (h.reason !== null) text(h.reason, "host reason", 80);
		if (h.candidateId !== null) text(h.candidateId, "candidate ID", 80);
		if (h.requiredBand !== null) integer(h.requiredBand, "host band", 3);
		if (h.tuple !== null) validateTuple(h.tuple, "host tuple");
		list(h.dispatches, "dispatches", 16);
		h.dispatches.forEach((tuple) => validateTuple(tuple, "dispatch tuple"));
		one(h.dispatchState, ["known", "unknown"], "dispatch state");
		const policy = replay(catalog, entry, record);
		const failures = [];
		const fail = (condition, reason) => {
			if (!condition) failures.push(reason);
		};
		fail(
			h.kind === entry.expected.kind && h.reason === entry.expected.reason,
			"expected-outcome",
		);
		fail(
			h.kind === policy.kind &&
				h.reason === policy.reason &&
				h.candidateId === policy.candidateId &&
				h.requiredBand === policy.requiredBand,
			"distribution-policy-disagreement",
		);
		fail(
			h.dispatches.every((tuple) => authorized(catalog, tuple)) &&
				(h.tuple === null || authorized(catalog, h.tuple)),
			"unauthorized-tuple",
		);
		fail(
			(h.candidateId === null && h.tuple === null) ||
				(h.tuple !== null && h.candidateId === h.tuple.id),
			"candidate-tuple-inconsistent",
		);
		fail(h.dispatches.length <= 1, "repeated-dispatch");
		fail(
			policy.kind !== "bypass" ||
				(h.kind === "bypass" &&
					h.dispatches.length === 0 &&
					h.tuple === null &&
					h.candidateId === null),
			"bypass-routed",
		);
		fail(
			policy.kind !== "abstain" ||
				(h.kind === "abstain" &&
					h.dispatches.length === 0 &&
					h.tuple === null &&
					h.candidateId === null),
			"abstain-routed",
		);
		fail(
			policy.kind !== "unknown" ||
				(h.kind === "unknown" &&
					h.dispatches.length === 0 &&
					h.dispatchState === "unknown"),
			"unknown-replayed-or-guessed",
		);
		fail(
			h.kind === "unknown" || h.dispatchState === "known",
			"unexpected-dispatch-uncertainty",
		);
		if (h.kind === "route") {
			fail(
				h.tuple !== null &&
					h.candidateId === h.tuple?.id &&
					h.dispatches.length === 1 &&
					canonical(h.dispatches[0]) === canonical(h.tuple) &&
					h.reason === null,
				"route-dispatch-inconsistent",
			);
			fail(entry.expected.roles.includes(h.tuple?.roleId), "role-mismatch");
			fail(entry.expected.tupleIds.includes(h.candidateId), "tuple-mismatch");
			fail(
				h.tuple !== null &&
					autoEffortBand(h.tuple.harness, h.tuple.effort) >=
						entry.expected.minBand &&
					tiers.indexOf(h.tuple.tier) >= Math.min(entry.expected.minBand, 2),
				"under-tier",
			);
			const role = catalog.roles.find((r) => r.id === h.tuple?.roleId);
			fail(role?.intent === entry.expected.mutation, "mutation-mismatch");
			fail(
				entry.expected.independence === "none" && role?.purpose !== "review",
				"independence-violation",
			);
		}
		violations.push(
			...failures.map((reason) => ({
				caseId: entry.id,
				decisionId: record.decisionId,
				reason,
			})),
		);
		evaluated.push({ entry, record, policy, failures });
	}
	check(
		caseIds.size === answered.size &&
			[...caseIds].every((id) => answered.has(id)),
		"missing case answers",
	);
	if (enforceSemantics)
		check(
			violations.length === 0,
			`semantic violations: ${JSON.stringify(violations)}`,
		);
	return { cases: evaluated, violations };
}

export const fixtureDirectory = new URL(
	"../fixtures/jev-routing/",
	import.meta.url,
);
export async function loadBundle(directory = fixtureDirectory) {
	const names = {
		catalog: "catalog.json",
		tune: "cases.tune.json",
		heldout: "cases.heldout.json",
		answers: "answers.synthetic.json",
	};
	return Object.fromEntries(
		await Promise.all(
			Object.entries(names).map(async ([key, file]) => [
				key,
				JSON.parse(await readFile(new URL(file, directory), "utf8")),
			]),
		),
	);
}
if (
	process.argv[1] &&
	pathToFileURL(process.argv[1]).href === import.meta.url
) {
	try {
		check(
			process.argv.length === 2,
			"usage: node --experimental-strip-types test/evals/jev-routing-validate.mjs",
		);
		const result = validateBundle(await loadBundle());
		console.log(
			JSON.stringify(
				{
					synthetic: true,
					thresholdsStatus: "uncalibrated",
					cases: result.cases.length,
					violations: result.violations.length,
					fixtureDirectory: fileURLToPath(fixtureDirectory),
				},
				null,
				2,
			),
		);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
