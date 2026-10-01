import "./isolated-agent-dir.ts";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	AUTO_ROUTING_OFF,
	DEFAULT_AUTO_ROUTING_THRESHOLDS,
	autoRoutingConfigDigest,
	type AutoRoutingThresholds,
	isAutoRoutingEnabled,
	loadAutoRoutingConfig,
	parseAutoRoutingConfig,
} from "../pi-extension/subagents/auto-routing-config.ts";
import {
	AUTO_ABSTAIN_REASONS,
	AUTO_BYPASS_REASONS,
	AUTO_CANCEL_REASONS,
	AUTO_HOLD_REASONS,
	AUTO_REASON_CODES,
	AUTO_ROUTING_DISCLOSURE_VERSION,
	AUTO_ROUTING_JEV_MODEL,
	AUTO_ROUTING_JEV_PROVIDER,
	AUTO_ROUTING_POLICY_VERSION,
	AUTO_ROUTING_QUESTION_VERSION,
	AUTO_UNAVAILABLE_REASONS,
} from "../pi-extension/subagents/auto-routing-policy.ts";
import {
	getSubagentsConfigExamplePath,
	getSubagentsConfigPath,
} from "../pi-extension/subagents/config-path.ts";
import {
	TASK_CATEGORY_DESCRIPTIONS,
	writeTaskModelConfig,
} from "../pi-extension/subagents/model-config.ts";
import { buildTaskModelInitPrompt } from "../pi-extension/subagents/task-model-init.ts";
import type { JsonObject } from "../pi-extension/subagents/type-guards.ts";

const SHA = "a".repeat(64);

function role(overrides: JsonObject = {}): any {
	return {
		id: "scout",
		agent: "scout",
		source: "package",
		definitionSha256: SHA,
		labelRole: "research",
		intent: "report",
		purpose: "task",
		responsibility: "Investigate the repository and report findings.",
		deliverable: "A written report with file references.",
		excludes: "Editing files, commits, or external actions.",
		...overrides,
	};
}

function candidate(overrides: JsonObject = {}): any {
	return {
		id: "scout-pi-mid",
		roleId: "scout",
		harness: "pi",
		model: { namespace: "pi", ref: "fake/worker-2" },
		effort: "medium",
		tier: "mid",
		family: "fake-family",
		taskStrengths: "Reliable repository reconnaissance.",
		limitations: "Weak at long architectural synthesis.",
		capabilityEvidence: "Reviewed against fake-provider release notes v2.",
		preference: 10,
		...overrides,
	};
}

function section(overrides: JsonObject = {}): any {
	return {
		version: 1,
		mode: "auto",
		policyVersion: "jev-auto-v1",
		questionVersion: "jev-auto-questions-v1",
		consent: {
			disclosureVersion: "jev-egress-v1",
			acknowledgedAt: "2026-09-30T00:00:00Z",
			sendCurrentPromptAndReviewedProfiles: true,
		},
		jev: { provider: "typesafe", model: "jev-1.13.0", timeoutMs: 5000 },
		roles: [role()],
		candidates: [candidate()],
		...overrides,
	};
}

function parse(autoRouting: any) {
	return parseAutoRoutingConfig({ autoRouting }, "test.json");
}

function enabled(autoRouting: any) {
	const config = parse(autoRouting);
	if (config.mode === "off") assert.fail("expected an enabled config");
	return config;
}

function rejects(autoRouting: any, pattern: RegExp) {
	assert.throws(
		() => parse(autoRouting),
		(error) => {
			assert.ok(error instanceof Error);
			assert.match(
				error.message,
				/^Invalid subagent auto-routing config in test\.json: /,
			);
			assert.match(error.message, pattern);
			return true;
		},
	);
}

function withCandidate(overrides: JsonObject): any {
	return section({ candidates: [candidate(overrides)] });
}

function withRole(overrides: JsonObject): any {
	return section({ roles: [role(overrides)] });
}

function assertDeepFrozen(value: any, path = "config") {
	if (Object(value) !== value) return;
	assert.ok(Object.isFrozen(value), `${path} must be frozen`);
	for (const [key, child] of Object.entries(value))
		assertDeepFrozen(child, `${path}.${key}`);
}

describe("parseAutoRoutingConfig", () => {
	it("treats a missing section as exactly version 1 off", () => {
		assert.equal(parseAutoRoutingConfig({}), AUTO_ROUTING_OFF);
		assert.deepEqual(parseAutoRoutingConfig({ models: { agents: {} } }), {
			version: 1,
			mode: "off",
		});
		assert.throws(
			() => parseAutoRoutingConfig([], "test.json"),
			/test\.json: root must be an object/,
		);
	});

	it("ignores unrelated top-level sections without validating them", () => {
		const config = parseAutoRoutingConfig({
			panes: { mode: "bogus" },
			models: null,
			autoRouting: section(),
		});
		assert.equal(config.mode, "auto");
	});

	it("accepts minimal off and requires exact version and mode", () => {
		assert.deepEqual(parse({ version: 1, mode: "off" }), AUTO_ROUTING_OFF);
		rejects({ mode: "off" }, /autoRouting\.version is required/);
		rejects({ version: "1", mode: "off" }, /autoRouting\.version must be 1/);
		rejects({ version: 2, mode: "off" }, /autoRouting\.version must be 1/);
		rejects({ version: 1 }, /autoRouting\.mode is required/);
		rejects({ version: 1, mode: "on" }, /autoRouting\.mode must be one of/);
		rejects({ version: 1, mode: "OFF" }, /autoRouting\.mode must be one of/);
	});

	it("rejects null substitution for omitted values and objects", () => {
		rejects(null, /autoRouting must be an object/);
		rejects([], /autoRouting must be an object/);
		rejects({ version: 1, mode: null }, /autoRouting\.mode must be one of/);
		rejects(
			section({ policyVersion: null }),
			/autoRouting\.policyVersion must be "jev-auto-v1"/,
		);
		rejects(
			section({ failurePolicy: null }),
			/autoRouting\.failurePolicy must be one of/,
		);
		rejects(
			section({ thresholds: null }),
			/autoRouting\.thresholds must be an object/,
		);
		rejects(
			section({ consent: null }),
			/autoRouting\.consent must be an object/,
		);
		rejects(section({ roles: null }), /autoRouting\.roles must be a list/);
		rejects(
			withRole({ provider: null, providerVersion: "1.0.0" }),
			/roles\[0\]\.provider must be a string/,
		);
		rejects(
			withCandidate({ model: null }),
			/candidates\[0\]\.model must be an object/,
		);
	});

	it("keeps off zero-egress: a retained configuration must be complete and is not exposed", () => {
		const retained = parse(section({ mode: "off" }));
		assert.equal(retained, AUTO_ROUTING_OFF);
		assert.deepEqual(Object.keys(retained).sort(), ["mode", "version"]);
		rejects(
			{ version: 1, mode: "off", failurePolicy: "hold" },
			/autoRouting\.policyVersion is required to retain an off configuration beyond version and mode/,
		);
		const partial = section({ mode: "off" });
		delete partial.consent;
		rejects(partial, /autoRouting\.consent is required to retain an off/);
		rejects(
			section({
				mode: "off",
				candidates: [candidate({ model: { namespace: "pi", ref: "worker" } })],
			}),
			/candidates\[0\]\.model\.ref must be an exact Pi provider\/model-id reference/,
		);
	});

	it("requires every approval field in enabled modes and applies explicit defaults", () => {
		for (const mode of ["shadow", "pilot", "auto"]) {
			const config = enabled(section({ mode }));
			assert.equal(config.mode, mode);
			assert.equal(config.failurePolicy, "parent");
			assert.deepEqual(config.thresholds, DEFAULT_AUTO_ROUTING_THRESHOLDS);
			assert.deepEqual(config.jev, {
				provider: "typesafe",
				model: "jev-1.13.0",
				timeoutMs: 5000,
			});
		}
		assert.equal(
			enabled(section({ failurePolicy: "hold" })).failurePolicy,
			"hold",
		);
		rejects(
			section({ failurePolicy: "fallback" }),
			/failurePolicy must be one of: "parent", "hold"/,
		);
		for (const key of [
			"policyVersion",
			"questionVersion",
			"consent",
			"jev",
			"roles",
			"candidates",
		]) {
			const incomplete = section({ mode: "shadow" });
			delete incomplete[key];
			rejects(
				incomplete,
				new RegExp(`autoRouting\\.${key} is required for shadow mode`),
			);
		}
	});

	it("rejects unknown keys at every level", () => {
		rejects(
			section({ extra: true }),
			/autoRouting has unsupported key\(s\): "extra"/,
		);
		rejects(
			section({
				consent: {
					disclosureVersion: "jev-egress-v1",
					acknowledgedAt: "2026-09-30T00:00:00Z",
					sendCurrentPromptAndReviewedProfiles: true,
					scope: "all",
				},
			}),
			/autoRouting\.consent has unsupported key\(s\): "scope"/,
		);
		rejects(
			section({
				jev: {
					provider: "typesafe",
					model: "jev-1.13.0",
					timeoutMs: 5000,
					retries: 2,
				},
			}),
			/autoRouting\.jev has unsupported key\(s\): "retries"/,
		);
		rejects(
			section({
				thresholds: { ...DEFAULT_AUTO_ROUTING_THRESHOLDS, bonus: 0.5 },
			}),
			/autoRouting\.thresholds has unsupported key\(s\): "bonus"/,
		);
		rejects(
			withRole({ model: "fake/worker" }),
			/roles\[0\] has unsupported key\(s\): "model"/,
		);
		rejects(
			withCandidate({ agent: "scout" }),
			/candidates\[0\] has unsupported key\(s\): "agent"/,
		);
		rejects(
			withCandidate({ model: { namespace: "pi", ref: "fake/w-1", id: "x" } }),
			/candidates\[0\]\.model has unsupported key\(s\): "id"/,
		);
		rejects(
			withCandidate({
				harness: "claude",
				effort: "high",
				model: { namespace: "claude", id: "claude-opus-4-1", ref: "x" },
			}),
			/candidates\[0\]\.model has unsupported key\(s\): "ref"/,
		);
	});

	it("rejects credentials, endpoints, and launch capability bags without echoing values", () => {
		for (const key of ["apiKey", "token", "baseUrl", "endpoint", "headers"]) {
			assert.throws(
				() =>
					parse(
						section({
							jev: {
								provider: "typesafe",
								model: "jev-1.13.0",
								timeoutMs: 5000,
								[key]: "sk-secret-value",
							},
						}),
					),
				(error) => {
					assert.ok(error instanceof Error);
					assert.match(
						error.message,
						new RegExp(
							`autoRouting\\.jev\\.${key} is not allowed: .*credentials or endpoints`,
						),
					);
					assert.doesNotMatch(error.message, /sk-secret-value/);
					return true;
				},
			);
		}
		rejects(
			section({ auth: { type: "api_key" } }),
			/autoRouting\.auth is not allowed: .*credentials or endpoints/,
		);
		for (const key of [
			"tools",
			"skills",
			"cwd",
			"worktree",
			"fork",
			"persistent",
			"interactive",
			"spawnAgents",
			"systemPrompt",
			"env",
			"permissions",
		]) {
			rejects(
				withCandidate({ [key]: "read,write" }),
				new RegExp(
					`candidates\\[0\\]\\.${key} is not allowed: launch capabilities`,
				),
			);
		}
		rejects(
			withRole({ tools: "read" }),
			/roles\[0\]\.tools is not allowed: launch capabilities/,
		);
	});

	it("rejects reserved and prototype keys and reserved IDs", () => {
		rejects(
			JSON.parse('{"version":1,"mode":"off","__proto__":{"mode":"auto"}}'),
			/autoRouting has reserved key "__proto__"/,
		);
		rejects(
			withRole({ constructor: "x" }),
			/roles\[0\] has reserved key "constructor"/,
		);
		rejects(
			withCandidate({
				model: JSON.parse(
					'{"namespace":"pi","ref":"fake/w-1","__proto__":{"id":"x"}}',
				),
			}),
			/candidates\[0\]\.model has reserved key "__proto__"/,
		);
		for (const id of ["none", "equivalent", "constructor", "prototype"]) {
			rejects(
				section({
					roles: [role({ id })],
					candidates: [candidate({ roleId: id })],
				}),
				new RegExp(`roles\\[0\\]\\.id cannot use reserved ID "${id}"`),
			);
			rejects(
				withCandidate({ id }),
				new RegExp(`candidates\\[0\\]\\.id cannot use reserved ID "${id}"`),
			);
		}
		rejects(
			withRole({ agent: "__proto__" }),
			/roles\[0\]\.agent cannot use reserved name/,
		);
		// Inherited values are never read in place of own properties.
		rejects(
			Object.assign(Object.create({ mode: "auto" }), { version: 1 }),
			/autoRouting\.mode is required/,
		);
	});

	it("pins consent, policy, and question versions", () => {
		rejects(
			section({ policyVersion: "jev-auto-v2" }),
			/policyVersion must be "jev-auto-v1"/,
		);
		rejects(
			section({ questionVersion: "jev-auto-questions-v2" }),
			/questionVersion must be "jev-auto-questions-v1"/,
		);
		const consent = (overrides: JsonObject) =>
			section({
				consent: {
					disclosureVersion: "jev-egress-v1",
					acknowledgedAt: "2026-09-30T00:00:00Z",
					sendCurrentPromptAndReviewedProfiles: true,
					...overrides,
				},
			});
		rejects(
			consent({ disclosureVersion: "jev-egress-v2" }),
			/consent\.disclosureVersion must be "jev-egress-v1"/,
		);
		for (const value of [false, "true", 1, null])
			rejects(
				consent({ sendCurrentPromptAndReviewedProfiles: value }),
				/consent\.sendCurrentPromptAndReviewedProfiles must be true/,
			);
		for (const acknowledgedAt of [
			"2026-09-30",
			"2026-09-30T00:00:00",
			"2026-09-30 00:00:00Z",
			"2026-09-30t00:00:00z",
			"2026-02-30T00:00:00Z",
			"2025-02-29T00:00:00Z",
			"2026-13-01T00:00:00Z",
			"2026-09-30T24:00:00Z",
			"2026-09-30T00:60:00Z",
			"2026-09-30T00:00:60Z",
			"2026-09-30T00:00:00+24:00",
			"2026-09-30T00:00:00+0100",
			"2026-09-30T00:00:00.Z",
			" 2026-09-30T00:00:00Z",
		])
			rejects(
				consent({ acknowledgedAt }),
				/consent\.acknowledgedAt must be a strict ISO-8601 timestamp/,
			);
		rejects(
			consent({ acknowledgedAt: 1759190400000 }),
			/consent\.acknowledgedAt must be a string/,
		);
		for (const acknowledgedAt of [
			"2024-02-29T23:59:59.123+05:30",
			"2026-09-30T00:00:00.123456789-08:00",
		])
			assert.equal(
				enabled(consent({ acknowledgedAt })).consent.acknowledgedAt,
				acknowledgedAt,
			);
	});

	it("pins the Jev provider and model and bounds the timeout", () => {
		const jev = (overrides: JsonObject) =>
			section({
				jev: {
					provider: "typesafe",
					model: "jev-1.13.0",
					timeoutMs: 5000,
					...overrides,
				},
			});
		for (const model of ["jev-latest", "jev-*", "jev-1.13", "task:routing"])
			rejects(jev({ model }), /autoRouting\.jev\.model must be "jev-1\.13\.0"/);
		rejects(
			jev({ provider: "openai" }),
			/autoRouting\.jev\.provider must be "typesafe"/,
		);
		for (const timeoutMs of [
			499,
			15_001,
			5000.5,
			"5000",
			Number.POSITIVE_INFINITY,
			Number.NaN,
		])
			rejects(
				jev({ timeoutMs }),
				/autoRouting\.jev\.timeoutMs must be an integer from 500 to 15000/,
			);
		const noTimeout = jev({});
		delete noTimeout.jev.timeoutMs;
		rejects(noTimeout, /autoRouting\.jev\.timeoutMs is required/);
		for (const timeoutMs of [500, 15_000])
			assert.equal(enabled(jev({ timeoutMs })).jev.timeoutMs, timeoutMs);
	});

	it("enforces conservative threshold bounds on a complete threshold object", () => {
		const bounds: Array<[keyof AutoRoutingThresholds, number, number]> = [
			["choiceConfidence", 0.8, 1],
			["choiceProbability", 0.7, 1],
			["choiceMargin", 0.2, 1],
			["absoluteFit", 0.8, 1],
			["falseCeiling", 0, 0.2],
			["trueFloor", 0.8, 1],
			["scoreConfidence", 0.8, 1],
			["effortQuantile", 0.9, 0.99],
		];
		assert.deepEqual(DEFAULT_AUTO_ROUTING_THRESHOLDS, {
			choiceConfidence: 0.8,
			choiceProbability: 0.7,
			choiceMargin: 0.2,
			absoluteFit: 0.8,
			falseCeiling: 0.2,
			trueFloor: 0.8,
			scoreConfidence: 0.8,
			effortQuantile: 0.9,
		});
		const thresholds = (overrides: JsonObject) =>
			section({
				thresholds: { ...DEFAULT_AUTO_ROUTING_THRESHOLDS, ...overrides },
			});
		for (const [key, min, max] of bounds) {
			for (const value of [min, max])
				assert.equal(
					enabled(thresholds({ [key]: value })).thresholds[key],
					value,
				);
			for (const value of [
				min - 0.001,
				max + 0.001,
				`${min}`,
				null,
				Number.NaN,
			])
				rejects(
					thresholds({ [key]: value }),
					new RegExp(
						`autoRouting\\.thresholds\\.${key} must be a finite number from ${min} to ${max}`,
					),
				);
			const incomplete = thresholds({});
			delete incomplete.thresholds[key];
			rejects(
				incomplete,
				new RegExp(`autoRouting\\.thresholds\\.${key} is required`),
			);
		}
	});

	it("validates role approvals", () => {
		rejects(section({ roles: [] }), /roles must be a list of 1 to 16 entries/);
		rejects(
			section({
				roles: Array.from({ length: 17 }, (_, index) =>
					role({ id: `r${index}` }),
				),
			}),
			/roles must be a list of 1 to 16 entries/,
		);
		for (const id of ["Scout", "1scout", "scout_x", "", "a".repeat(41), 7])
			rejects(withRole({ id }), /roles\[0\]\.id must match/);
		assert.equal(
			enabled(
				section({
					roles: [role({ id: "a".repeat(40) })],
					candidates: [candidate({ roleId: "a".repeat(40) })],
				}),
			).roles[0].id,
			"a".repeat(40),
		);
		rejects(
			section({ roles: [role(), role({ agent: "other" })] }),
			/roles has duplicate id "scout"/,
		);
		rejects(
			withRole({ agent: " scout" }),
			/roles\[0\]\.agent must not have leading or trailing whitespace/,
		);
		rejects(withRole({ agent: "" }), /roles\[0\]\.agent must be a non-empty/);
		rejects(
			withRole({ agent: "scout\u0007" }),
			/roles\[0\]\.agent must not contain control characters/,
		);
		rejects(withRole({ source: "local" }), /roles\[0\]\.source must be one of/);
		rejects(
			withRole({ provider: "role-pack" }),
			/roles\[0\]\.provider and autoRouting\.roles\[0\]\.providerVersion must be set together/,
		);
		rejects(
			withRole({ source: "project", provider: "pack", providerVersion: "1" }),
			/roles\[0\]\.provider is only valid for a package role/,
		);
		const contributed = enabled(
			withRole({ provider: "@acme/roles", providerVersion: "1.2.3" }),
		).roles[0];
		assert.equal(contributed.provider, "@acme/roles");
		assert.equal(contributed.providerVersion, "1.2.3");
		assert.equal(Object.hasOwn(enabled(section()).roles[0], "provider"), false);
		for (const definitionSha256 of [
			"A".repeat(64),
			"a".repeat(63),
			"g".repeat(64),
		])
			rejects(
				withRole({ definitionSha256 }),
				/roles\[0\]\.definitionSha256 must be 64 lower-case hexadecimal digits/,
			);
		rejects(withRole({ labelRole: "coder" }), /labelRole must be one of/);
		rejects(withRole({ intent: "write" }), /intent must be one of/);
		rejects(withRole({ purpose: "audit" }), /purpose must be one of/);
		rejects(
			withRole({ labelRole: "review" }),
			/roles\[0\]\.purpose must be "review" for a review responsibility/,
		);
		assert.equal(
			enabled(withRole({ labelRole: "review", purpose: "review" })).roles[0]
				.purpose,
			"review",
		);
		for (const key of ["responsibility", "deliverable", "excludes"] as const) {
			rejects(
				withRole({ [key]: "   " }),
				new RegExp(`roles\\[0\\]\\.${key} must be a non-empty string`),
			);
			for (const unsafe of ["line\nbreak", "\u202Eevil", "\ud800", "a\u2028b"])
				rejects(
					withRole({ [key]: unsafe }),
					new RegExp(`roles\\[0\\]\\.${key} must not contain control`),
				);
			for (const oversized of ["x".repeat(257), "\u00e9".repeat(129)])
				rejects(
					withRole({ [key]: oversized }),
					new RegExp(`roles\\[0\\]\\.${key} must be at most 256 UTF-8 bytes`),
				);
			assert.equal(
				enabled(withRole({ [key]: "\u00e9".repeat(128) })).roles[0][key],
				"\u00e9".repeat(128),
			);
		}
		rejects(
			section({ roles: [role(), role({ id: "idle" })] }),
			/roles role "idle" has no approved candidate/,
		);
	});

	it("validates candidate tuples, namespaces, and exact model pins", () => {
		rejects(
			section({ candidates: [] }),
			/candidates must be a list of 1 to 128 entries/,
		);
		rejects(
			section({
				candidates: Array.from({ length: 129 }, (_, index) =>
					candidate({
						id: `c${index}`,
						model: { namespace: "pi", ref: `fake/worker-${index}` },
					}),
				),
			}),
			/candidates must be a list of 1 to 128 entries/,
		);
		rejects(
			withCandidate({ roleId: "ghost" }),
			/candidates\[0\]\.roleId references unknown role "ghost"/,
		);
		rejects(
			section({
				candidates: [
					candidate(),
					candidate({ effort: "high", preference: 11 }),
				],
			}),
			/candidates has duplicate id "scout-pi-mid"/,
		);
		rejects(
			section({
				candidates: [candidate(), candidate({ id: "again", preference: 11 })],
			}),
			/candidates\[1\] duplicates an approved role, harness, model, and effort tuple/,
		);
		rejects(
			section({
				candidates: [candidate(), candidate({ id: "high", effort: "high" })],
			}),
			/candidates\[1\]\.preference must be unique within one role, harness, and model/,
		);
		assert.equal(
			enabled(
				section({
					candidates: [
						candidate(),
						candidate({
							id: "other-model",
							model: { namespace: "pi", ref: "fake/worker-3" },
						}),
					],
				}),
			).candidates.length,
			2,
		);
		rejects(
			withCandidate({
				harness: "claude",
				model: { namespace: "pi", ref: "fake/worker-2" },
			}),
			/candidates\[0\]\.model\.namespace must equal the candidate harness "claude"/,
		);
		rejects(
			withCandidate({ model: { namespace: "kiro", id: "claude-sonnet-4.5" } }),
			/candidates\[0\]\.model\.namespace must equal the candidate harness "pi"/,
		);
		rejects(
			withCandidate({ model: { namespace: "openai", ref: "x/y-1" } }),
			/candidates\[0\]\.model\.namespace must be one of/,
		);
		for (const ref of ["worker", "fake/", "/worker-1", "fake"])
			rejects(
				withCandidate({ model: { namespace: "pi", ref } }),
				/model\.ref must be an exact Pi provider\/model-id reference/,
			);
		for (const ref of ["fake/a-1,fake/b-2", "fake/ worker-1", "fake/w-1\t"])
			rejects(
				withCandidate({ model: { namespace: "pi", ref } }),
				/model\.ref must (?:be one exact Pi provider\/model reference|not contain control)/,
			);
		rejects(
			withCandidate({ model: { namespace: "pi", ref: "task:coding" } }),
			/model\.ref cannot use task: references/,
		);
		for (const ref of [
			"openrouter/auto",
			"fake/model-latest",
			"fake/default",
			"anthropic/claude-sonnet-latest",
		])
			rejects(
				withCandidate({ model: { namespace: "pi", ref } }),
				/model\.ref must name an exact pinned model, not a moving alias/,
			);
		rejects(
			withCandidate({
				model: { namespace: "pi", ref: `fake/${"m".repeat(196)}` },
			}),
			/model\.ref must be at most 200 UTF-8 bytes/,
		);
		const native = (harness: string, id: any, effort = "high") =>
			withCandidate({ harness, effort, model: { namespace: harness, id } });
		for (const id of [
			"opus",
			"sonnet",
			"haiku",
			"opusplan",
			"auto",
			"default",
			"latest",
			"claude-sonnet-latest",
			"claude-4-auto",
			"sonnet[1m]",
		])
			rejects(
				native("claude", id),
				/model\.id must be an administrator-verified exact versioned native model ID/,
			);
		rejects(
			native("kiro", "task:coding"),
			/model\.id cannot use task: references/,
		);
		for (const id of [
			"claude-opus-4,claude-sonnet-4",
			" claude-opus-4",
			"claude opus 4",
			"-claude-4",
		])
			rejects(
				native("claude", id),
				/model\.id must be one native CLI model ID/,
			);
		rejects(
			native("claude", "x1".repeat(101)),
			/model\.id must be at most 200 UTF-8 bytes/,
		);
		rejects(native("claude", ""), /model\.id must be a non-empty string/);
		for (const [harness, id] of [
			["claude", "claude-opus-4-1-20250805"],
			["claude", "claude-sonnet-4-5[1m]"],
			["claude", "us.anthropic/claude-sonnet-4.5"],
			["kiro", "claude-sonnet-4.5"],
		])
			assert.deepEqual(enabled(native(harness, id)).candidates[0].model, {
				namespace: harness,
				id,
			});
		for (const effort of ["off", "minimal"])
			rejects(
				native("kiro", "claude-sonnet-4.5", effort),
				new RegExp(
					`candidates\\[0\\]\\.effort "${effort}" cannot be represented by native kiro`,
				),
			);
		assert.equal(
			enabled(withCandidate({ effort: "off" })).candidates[0].effort,
			"off",
		);
		rejects(withCandidate({ effort: "extreme" }), /effort must be one of/);
		rejects(withCandidate({ tier: "ultra" }), /tier must be one of/);
		rejects(
			withCandidate({ family: "f".repeat(81) }),
			/family must be at most 80 UTF-8 bytes/,
		);
		rejects(
			withCandidate({ capabilityEvidence: "e".repeat(513) }),
			/capabilityEvidence must be at most 512 UTF-8 bytes/,
		);
		assert.equal(
			enabled(withCandidate({ capabilityEvidence: "e".repeat(512) }))
				.candidates[0].capabilityEvidence.length,
			512,
		);
		for (const key of ["taskStrengths", "limitations"])
			rejects(
				withCandidate({ [key]: "s".repeat(257) }),
				new RegExp(`${key} must be at most 256 UTF-8 bytes`),
			);
		for (const preference of [-1, 10_001, 1.5, "1", null])
			rejects(
				withCandidate({ preference }),
				/preference must be an integer from 0 to 10000/,
			);
		for (const preference of [0, 10_000])
			assert.equal(
				enabled(withCandidate({ preference })).candidates[0].preference,
				preference,
			);
	});

	it("returns a deeply immutable value detached from the input", () => {
		const raw = section({
			roles: [role({ provider: "@acme/roles", providerVersion: "1.0.0" })],
		});
		const config = enabled(raw);
		assertDeepFrozen(config);
		raw.roles[0].agent = "mutated";
		raw.candidates[0].model.ref = "fake/mutated-1";
		assert.equal(config.roles[0].agent, "scout");
		assert.deepEqual(config.candidates[0].model, {
			namespace: "pi",
			ref: "fake/worker-2",
		});
		assert.throws(() => {
			// SAFETY: deliberately bypasses readonly typing to prove runtime immutability.
			(config.candidates as any[]).push(candidate());
		}, TypeError);
		assert.throws(() => {
			// SAFETY: deliberately bypasses readonly typing to prove runtime immutability.
			(config.jev as any).timeoutMs = 1;
		}, TypeError);
	});

	it("computes a canonical digest over parsed semantics", () => {
		const base = autoRoutingConfigDigest(parse(section()));
		assert.match(base, /^[0-9a-f]{64}$/);
		const reordered = Object.fromEntries(Object.entries(section()).reverse());
		assert.equal(autoRoutingConfigDigest(parse(reordered)), base);
		assert.equal(
			autoRoutingConfigDigest(
				parse(
					section({
						failurePolicy: "parent",
						thresholds: { ...DEFAULT_AUTO_ROUTING_THRESHOLDS },
					}),
				),
			),
			base,
		);
		for (const changed of [
			section({ mode: "pilot" }),
			section({ failurePolicy: "hold" }),
			withCandidate({ preference: 11 }),
			withRole({ excludes: "Editing files." }),
		])
			assert.notEqual(autoRoutingConfigDigest(parse(changed)), base);
		const off = autoRoutingConfigDigest(AUTO_ROUTING_OFF);
		assert.equal(autoRoutingConfigDigest(parseAutoRoutingConfig({})), off);
		assert.equal(
			autoRoutingConfigDigest(parse({ version: 1, mode: "off" })),
			off,
		);
		assert.equal(autoRoutingConfigDigest(parse(section({ mode: "off" }))), off);
	});
});

describe("loadAutoRoutingConfig", () => {
	const isolatedAgentDir = process.env.PI_CODING_AGENT_DIR;
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "auto-routing-config-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	function writeDurable(text: string) {
		const path = getSubagentsConfigPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
		return path;
	}

	function writeDurableJson(value: any) {
		return writeDurable(`${JSON.stringify(value, null, 2)}\n`);
	}

	it("reports a missing durable file as off and never falls back to the packaged example", () => {
		const loaded = loadAutoRoutingConfig();
		assert.deepEqual(loaded, {
			status: "off",
			source: join(agentDir, "herdr-agents", "config.json"),
			origin: "missing-file",
			config: AUTO_ROUTING_OFF,
			digest: autoRoutingConfigDigest(AUTO_ROUTING_OFF),
		});
		assert.notEqual(loaded.source, getSubagentsConfigExamplePath());
		assert.equal(isAutoRoutingEnabled(loaded), false);
		assertDeepFrozen(loaded, "loaded");
	});

	it("distinguishes a missing section, configured off, enabled, and invalid", () => {
		writeDurableJson({ panes: { mode: "tab" } });
		const missing = loadAutoRoutingConfig();
		assert.equal(missing.status, "off");
		assert.equal(missing.status === "off" && missing.origin, "missing-section");

		writeDurableJson({ autoRouting: section({ mode: "off" }) });
		const off = loadAutoRoutingConfig();
		assert.equal(off.status, "off");
		assert.equal(off.status === "off" && off.origin, "configured");
		assert.equal(isAutoRoutingEnabled(off), false);
		assert.equal(off.status === "off" && off.config, AUTO_ROUTING_OFF);

		writeDurableJson({ panes: { mode: "tab" }, autoRouting: section() });
		const loaded = loadAutoRoutingConfig();
		assert.ok(isAutoRoutingEnabled(loaded));
		assert.equal(loaded.config.mode, "auto");
		assert.equal(loaded.digest, autoRoutingConfigDigest(parse(section())));
		assertDeepFrozen(loaded, "loaded");

		const path = writeDurableJson({
			autoRouting: withCandidate({ tier: "x" }),
		});
		const invalid = loadAutoRoutingConfig();
		assert.equal(invalid.status, "invalid");
		assert.equal(isAutoRoutingEnabled(invalid), false);
		assert.equal(
			invalid.status === "invalid" && invalid.diagnostic,
			`Invalid subagent auto-routing config in ${path}: autoRouting.candidates[0].tier must be one of: "fast", "mid", "frontier"`,
		);
		assertDeepFrozen(invalid, "invalid");
	});

	it("never hides unreadable files, invalid JSON, or overflowing numbers as off", () => {
		mkdirSync(getSubagentsConfigPath(), { recursive: true });
		const unreadable = loadAutoRoutingConfig();
		assert.equal(unreadable.status, "invalid");
		assert.match(
			unreadable.status === "invalid" ? unreadable.diagnostic : "",
			/^Cannot read subagent config /,
		);
		rmSync(getSubagentsConfigPath(), { recursive: true });

		writeDurable("{");
		const syntax = loadAutoRoutingConfig();
		assert.equal(syntax.status, "invalid");
		assert.match(
			syntax.status === "invalid" ? syntax.diagnostic : "",
			/^Invalid JSON in subagent config /,
		);

		writeDurable(
			JSON.stringify({ autoRouting: section() }).replace(
				'"timeoutMs":5000',
				'"timeoutMs":1e400',
			),
		);
		const overflow = loadAutoRoutingConfig();
		assert.equal(overflow.status, "invalid");
		assert.match(
			overflow.status === "invalid" ? overflow.diagnostic : "",
			/autoRouting\.jev\.timeoutMs must be an integer/,
		);
	});

	it("rejects duplicate JSON members inside autoRouting only", () => {
		const cases: Array<[string, string]> = [
			[
				'{"autoRouting":{"version":1,"mode":"off","mode":"auto"}}',
				"autoRouting.mode",
			],
			[
				'{"autoRouting":{"version":1,"mode":"off"},"autoRouting":{"version":1,"mode":"auto"}}',
				"autoRouting",
			],
			[
				'{"autoRouting":{"version":1,"mode":"off","\\u006dode":"auto"}}',
				"autoRouting.mode",
			],
			[
				JSON.stringify({ autoRouting: section() }).replace(
					'"agent":"scout"',
					'"agent":"scout","agent":"worker"',
				),
				"autoRouting.roles[0].agent",
			],
		];
		for (const [text, member] of cases) {
			writeDurable(text);
			const loaded = loadAutoRoutingConfig();
			assert.equal(loaded.status, "invalid", text);
			assert.match(
				loaded.status === "invalid" ? loaded.diagnostic : "",
				new RegExp(
					`: ${member.replace(/[.[\]]/g, "\\$&")} is a duplicate JSON member$`,
				),
			);
		}

		writeDurable(
			'{"panes":{"mode":"tab","mode":"split"},"models":{"agents":{"autoRouting":"a","autoRouting":"b"}}}',
		);
		const outside = loadAutoRoutingConfig();
		assert.equal(outside.status, "off");
		assert.equal(outside.status === "off" && outside.origin, "missing-section");

		const tricky = section({
			roles: [
				role({ responsibility: 'Quote "}{\\"mode\\":" and [brackets], ok.' }),
			],
		});
		writeDurableJson({ autoRouting: tricky });
		assert.equal(loadAutoRoutingConfig().status, "enabled");
	});

	// Deep enough to exhaust the call stack of a recursive scanner.
	const DEPTH = 100_000;
	const deepArray = (inner = "") =>
		`${"[".repeat(DEPTH)}${inner}${"]".repeat(DEPTH)}`;

	it("skips deeply nested unrelated top-level JSON without exhausting the stack", () => {
		const deepDuplicates = `${'{"autoRouting":0,"autoRouting":'.repeat(DEPTH)}0${"}".repeat(DEPTH)}`;
		const unrelated = `"panes":${deepArray()},"models":${deepDuplicates}`;

		writeDurable(`{${unrelated}}`);
		const missing = loadAutoRoutingConfig();
		assert.equal(missing.status, "off");
		assert.equal(missing.status === "off" && missing.origin, "missing-section");

		writeDurable(
			`{${unrelated},"autoRouting":${JSON.stringify(section())},"tail":${deepArray()}}`,
		);
		assert.equal(loadAutoRoutingConfig().status, "enabled");

		const off = '{"version":1,"mode":"off"}';
		const path = writeDurable(
			`{"autoRouting":${off},${unrelated},"autoRouting":${off}}`,
		);
		const duplicate = loadAutoRoutingConfig();
		assert.equal(duplicate.status, "invalid");
		assert.equal(
			duplicate.status === "invalid" && duplicate.diagnostic,
			`Invalid subagent auto-routing config in ${path}: autoRouting is a duplicate JSON member`,
		);
	});

	it("scans deeply nested autoRouting values and reports them as invalid", () => {
		const path = writeDurable(
			`{"autoRouting":{"version":1,"mode":"off","extra":${deepArray()}}}`,
		);
		const schema = loadAutoRoutingConfig();
		assert.equal(schema.status, "invalid");
		assert.equal(
			schema.status === "invalid" && schema.diagnostic,
			`Invalid subagent auto-routing config in ${path}: autoRouting has unsupported key(s): "extra"`,
		);

		writeDurable(
			`{"autoRouting":{"version":1,"mode":"off","extra":${deepArray('{"a":1,"a":2}')}}}`,
		);
		const nested = loadAutoRoutingConfig();
		assert.equal(nested.status, "invalid");
		assert.equal(
			nested.status === "invalid" && nested.diagnostic,
			`Invalid subagent auto-routing config in ${path}: autoRouting.extra${"[0]".repeat(DEPTH)}.a is a duplicate JSON member`,
		);

		writeDurable(
			`{"autoRouting":{"version":1,"extra":${deepArray("[1,{}]")},"mode":"off","mode":"auto"}}`,
		);
		const sibling = loadAutoRoutingConfig();
		assert.equal(sibling.status, "invalid");
		assert.equal(
			sibling.status === "invalid" && sibling.diagnostic,
			`Invalid subagent auto-routing config in ${path}: autoRouting.mode is a duplicate JSON member`,
		);
	});

	it("reports duplicate-member scanner failures as invalid instead of throwing", (t) => {
		const path = writeDurableJson({ autoRouting: section() });
		const parseJson = JSON.parse;
		// Simulate a scanner fault while it decodes the top-level member name.
		t.mock.method(JSON, "parse", (text: string, reviver?: any) => {
			if (text === '"autoRouting"')
				throw new RangeError("simulated scanner failure");
			return parseJson(text, reviver);
		});
		const loaded = loadAutoRoutingConfig();
		assert.equal(loaded.status, "invalid");
		assert.equal(
			loaded.status === "invalid" && loaded.diagnostic,
			`Cannot check subagent auto-routing config in ${path} for duplicate JSON members: simulated scanner failure`,
		);
		assertDeepFrozen(loaded, "loaded");
	});

	it("keeps the earlier snapshot immutable when the durable file drifts", () => {
		writeDurableJson({ autoRouting: section() });
		const first = loadAutoRoutingConfig();
		writeDurableJson({ autoRouting: withCandidate({ preference: 99 }) });
		const second = loadAutoRoutingConfig();
		assert.ok(isAutoRoutingEnabled(first) && isAutoRoutingEnabled(second));
		assert.notEqual(first.digest, second.digest);
		assert.equal(first.config.candidates[0].preference, 10);
		assert.equal(first.digest, autoRoutingConfigDigest(first.config));
		rmSync(getSubagentsConfigPath());
		assert.equal(loadAutoRoutingConfig().status, "off");
		assert.equal(first.config.mode, "auto");
	});

	const duplicateWriterSources = [
		{
			name: "mode off/auto",
			member: "autoRouting.mode",
			text: () =>
				JSON.stringify({ autoRouting: section() }).replace(
					'"mode":"auto"',
					'"mode":"off","mode":"auto"',
				),
		},
		{
			name: "mode auto/off",
			member: "autoRouting.mode",
			text: () =>
				JSON.stringify({ autoRouting: section() }).replace(
					'"mode":"auto"',
					'"mode":"auto","mode":"off"',
				),
		},
		{
			name: "escaped mode off/auto",
			member: "autoRouting.mode",
			text: () =>
				JSON.stringify({ autoRouting: section() }).replace(
					'"mode":"auto"',
					'"mode":"off","\\u006dode":"auto"',
				),
		},
		{
			name: "top-level autoRouting",
			member: "autoRouting",
			text: () =>
				`{"autoRouting":{"version":1,"mode":"off"},"autoRouting":${JSON.stringify(section())}}`,
		},
		{
			name: "nested role member",
			member: "autoRouting.roles[0].agent",
			text: () =>
				JSON.stringify({ autoRouting: section() }).replace(
					'"agent":"scout"',
					'"agent":"worker","agent":"scout"',
				),
		},
	];
	for (const origin of ["current", "example"] as const) {
		for (const fixture of duplicateWriterSources) {
			it(`refuses duplicate ${fixture.name} in ${origin} before any task-model write`, () => {
				const path = getSubagentsConfigPath();
				const exampleRoot = join(agentDir, "example");
				const examplePath = join(exampleRoot, "herdr-agents", "config.json");
				const sourcePath = origin === "current" ? path : examplePath;
				mkdirSync(dirname(sourcePath), { recursive: true });
				writeFileSync(sourcePath, fixture.text());
				const beforeBytes = readFileSync(sourcePath);
				const beforeFiles = readdirSync(dirname(sourcePath));
				const loadSource = () => {
					const previous = process.env.PI_CODING_AGENT_DIR;
					process.env.PI_CODING_AGENT_DIR =
						origin === "current" ? agentDir : exampleRoot;
					try {
						return loadAutoRoutingConfig();
					} finally {
						process.env.PI_CODING_AGENT_DIR = previous;
					}
				};
				const before = loadSource();
				assert.equal(before.status, "invalid");
				assert.equal(
					before.status === "invalid" && before.diagnostic,
					`Invalid subagent auto-routing config in ${sourcePath}: ${fixture.member} is a duplicate JSON member`,
				);
				let writes = 0;
				let renames = 0;
				assert.throws(
					() =>
						writeTaskModelConfig(
							path,
							examplePath,
							{ coding: ["fake/worker"] },
							{ generatedAt: "2026-09-30T00:00:00Z", method: "registry-only" },
							() => true,
							{
								writeFileSync: () => {
									writes++;
									assert.fail("must reject before temporary write");
								},
								renameSync: () => {
									renames++;
									assert.fail("must reject before rename");
								},
							},
						),
					{ message: before.status === "invalid" ? before.diagnostic : "" },
				);
				assert.equal(writes, 0);
				assert.equal(renames, 0);
				assert.deepEqual(readFileSync(sourcePath), beforeBytes);
				assert.deepEqual(readdirSync(dirname(sourcePath)), beforeFiles);
				assert.deepEqual(
					loadSource(),
					before,
					"source remains invalid, not enabled or silently disabled",
				);
				if (origin === "example") {
					assert.equal(existsSync(path), false);
					assert.equal(existsSync(dirname(path)), false);
				}
			});
		}
	}

	it("fails closed before task-model writing when the duplicate scanner throws", (t) => {
		const path = writeDurableJson({ autoRouting: section() });
		const before = readFileSync(path);
		const parseJson = JSON.parse;
		t.mock.method(JSON, "parse", (text: string, reviver?: any) => {
			if (text === '"autoRouting"')
				throw new RangeError("simulated scanner failure");
			return parseJson(text, reviver);
		});
		assert.throws(
			() =>
				writeTaskModelConfig(
					path,
					getSubagentsConfigExamplePath(),
					{ coding: ["fake/worker"] },
					{ generatedAt: "2026-09-30T00:00:00Z", method: "registry-only" },
					() => true,
					{
						writeFileSync: () => assert.fail("must not write"),
						renameSync: () => assert.fail("must not rename"),
					},
				),
			/Cannot check subagent auto-routing config .* for duplicate JSON members: simulated scanner failure/,
		);
		assert.deepEqual(readFileSync(path), before);
	});

	it("continues to allow unrelated duplicate members outside autoRouting when writing tasks", () => {
		const path = writeDurable(
			'{"panes":{"mode":"tab","mode":"split"},"models":{"agents":{"autoRouting":"a","autoRouting":"b"}},"autoRouting":{"version":1,"mode":"off"}}',
		);
		const before = loadAutoRoutingConfig();
		assert.equal(before.status, "off");
		writeTaskModelConfig(
			path,
			getSubagentsConfigExamplePath(),
			{ coding: ["fake/worker"] },
			{ generatedAt: "2026-09-30T00:00:00Z", method: "registry-only" },
			() => true,
		);
		assert.deepEqual(loadAutoRoutingConfig(), before);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(saved.panes.mode, "split");
		assert.equal(saved.models.agents.autoRouting, "b");
		assert.deepEqual(saved.models.tasks, { coding: ["fake/worker"] });
	});

	it("keeps autoRouting unchanged when writing task model preferences", () => {
		const tasksMeta = {
			generatedAt: "2026-09-30T00:00:00Z",
			method: "registry-only" as const,
		};
		for (const autoRouting of [section(), section({ mode: "off" })]) {
			const original = {
				status: { enabled: false },
				panes: { mode: "tab" },
				models: { default: "fake/default" },
				autoRouting,
			};
			const path = writeDurableJson(original);
			const before = loadAutoRoutingConfig();
			writeTaskModelConfig(
				path,
				getSubagentsConfigExamplePath(),
				{ coding: ["fake/worker"] },
				tasksMeta,
				(candidate) => candidate === "fake/worker",
			);
			const written = JSON.parse(readFileSync(path, "utf8"));
			assert.deepEqual(written.autoRouting, autoRouting);
			assert.deepEqual(written.status, original.status);
			assert.deepEqual(written.panes, original.panes);
			assert.deepEqual(written.models, {
				default: "fake/default",
				tasks: { coding: ["fake/worker"] },
				tasksMeta,
			});
			assert.deepEqual(loadAutoRoutingConfig(), before);
		}
	});

	it("never opts in when task model preferences seed a new config", () => {
		const path = getSubagentsConfigPath();
		writeTaskModelConfig(
			path,
			getSubagentsConfigExamplePath(),
			{ coding: ["fake/worker"] },
			{ generatedAt: "2026-09-30T00:00:00Z", method: "research" },
			(candidate) => candidate === "fake/worker",
		);
		const loaded = loadAutoRoutingConfig();
		assert.equal(loaded.status, "off");
		assert.equal(isAutoRoutingEnabled(loaded), false);
		const written = JSON.parse(readFileSync(path, "utf8"));
		assert.ok(
			!Object.hasOwn(written, "autoRouting") ||
				written.autoRouting.mode === "off",
		);
	});
});

describe("automatic-routing operator guidance", () => {
	it("ships only a disabled, model-neutral example without approval or consent", () => {
		const example = JSON.parse(
			readFileSync(getSubagentsConfigExamplePath(), "utf8"),
		);
		assert.deepEqual(example.autoRouting, { version: 1, mode: "off" });
		assert.deepEqual(example.models, { agents: {} });
		assert.equal(parseAutoRoutingConfig(example), AUTO_ROUTING_OFF);
	});

	it("separates task-model init preferences from automatic routing authorization", () => {
		const prompt = buildTaskModelInitPrompt({
			operatorPreferences: "",
			categories: TASK_CATEGORY_DESCRIPTIONS,
			current: { agents: {} },
			models: [],
		});
		assert.match(
			prompt,
			/Task model preferences do not enable or authorize automatic input routing/,
		);
		assert.match(prompt, /preserve unrelated autoRouting settings/);
		assert.match(prompt, /without granting egress consent/);
		assert.match(prompt, /approving role\/harness\/model\/effort tuples/);
		assert.match(prompt, /or changing its mode/);
		assert.match(
			prompt,
			/writer rejects duplicate JSON members inside autoRouting/,
		);
		assert.match(prompt, /current file or example source before any write/);
		assert.match(prompt, /do not repair ambiguous approval JSON/);
		assert.match(prompt, /README\.md#automatic-input-routing/);
	});
});

describe("auto-routing domain vocabulary", () => {
	it("pins the shipped policy, question, disclosure, and classifier versions", () => {
		assert.equal(AUTO_ROUTING_POLICY_VERSION, "jev-auto-v1");
		assert.equal(AUTO_ROUTING_QUESTION_VERSION, "jev-auto-questions-v1");
		assert.equal(AUTO_ROUTING_DISCLOSURE_VERSION, "jev-egress-v1");
		assert.equal(AUTO_ROUTING_JEV_PROVIDER, "typesafe");
		assert.equal(AUTO_ROUTING_JEV_MODEL, "jev-1.13.0");
	});

	it("keeps reason codes unique, kebab-case, frozen, and partitioned", () => {
		const groups = [
			AUTO_BYPASS_REASONS,
			AUTO_ABSTAIN_REASONS,
			AUTO_UNAVAILABLE_REASONS,
			AUTO_CANCEL_REASONS,
			AUTO_HOLD_REASONS,
		];
		assert.deepEqual(AUTO_REASON_CODES, groups.flat());
		assert.equal(new Set(AUTO_REASON_CODES).size, AUTO_REASON_CODES.length);
		assert.ok(Object.isFrozen(AUTO_REASON_CODES));
		for (const code of AUTO_REASON_CODES)
			assert.match(code, /^[a-z]+(?:-[a-z0-9]+)*$/);
		for (const code of [
			"unsupported-input-contract",
			"clarification-required",
			"semantic-uncertainty",
			"role-overlap",
			"review-provenance-required",
			"no-sufficient-runtime",
		])
			assert.ok(
				AUTO_REASON_CODES.some((known) => known === code),
				code,
			);
	});
});
