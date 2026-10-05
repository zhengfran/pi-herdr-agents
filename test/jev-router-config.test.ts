import "./isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	findDuplicateAutoRoutingMember,
	findDuplicateJevRouterMember,
} from "../pi-extension/subagents/auto-routing-json.ts";
import {
	JEV_ROUTER_OFF,
	loadJevRouterConfig,
	parseJevRouterConfig,
} from "../pi-extension/subagents/jev-router-config.ts";
import {
	writeTaskModelConfig,
	type TaskPreferences,
} from "../pi-extension/subagents/model-config.ts";
import { ENABLED_RAW } from "./jev-router-fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "jev-router-config-"));
let counter = 0;
function configFile(text: string): string {
	const path = join(dir, `config-${counter++}.json`);
	writeFileSync(path, text);
	return path;
}

describe("jevRouter configuration", () => {
	it("is off by default and in the shipped example, which gives no consent", () => {
		assert.equal(parseJevRouterConfig(undefined), JEV_ROUTER_OFF);
		const example = JSON.parse(
			readFileSync(new URL("../config.json.example", import.meta.url), "utf8"),
		);
		assert.deepEqual(example.jevRouter, { version: 1, enabled: false });
		assert.deepEqual(parseJevRouterConfig(example.jevRouter), JEV_ROUTER_OFF);
	});

	it("treats a missing file or section as off without reading anything else", () => {
		const missingFile = loadJevRouterConfig(join(dir, "absent.json"));
		assert.equal(missingFile.status, "off");
		const missingSection = loadJevRouterConfig(configFile("{}"));
		assert.equal(missingSection.status, "off");
		if (missingSection.status === "off")
			assert.equal(missingSection.origin, "missing-section");
	});

	it("accepts a complete enabled section with the default and a bounded timeout", () => {
		const config = parseJevRouterConfig(ENABLED_RAW);
		assert.ok(config.enabled);
		if (config.enabled) assert.equal(config.timeoutMs, 5000);
		const custom = parseJevRouterConfig({ ...ENABLED_RAW, timeoutMs: 15000 });
		assert.ok(custom.enabled && custom.timeoutMs === 15000);
		const loaded = loadJevRouterConfig(
			configFile(JSON.stringify({ jevRouter: ENABLED_RAW })),
		);
		assert.equal(loaded.status, "enabled");
	});

	for (const [label, raw] of [
		["a missing consent", { ...ENABLED_RAW, consent: undefined }],
		[
			"a wrong disclosure",
			{
				...ENABLED_RAW,
				consent: { ...ENABLED_RAW.consent, disclosureVersion: "other" },
			},
		],
		[
			"a false acknowledgement",
			{
				...ENABLED_RAW,
				consent: {
					...ENABLED_RAW.consent,
					sendExplicitBriefAndRouteDescriptions: false,
				},
			},
		],
		[
			"a bad timestamp",
			{
				...ENABLED_RAW,
				consent: {
					...ENABLED_RAW.consent,
					acknowledgedAt: "2026-13-40T00:00:00Z",
				},
			},
		],
		["a bad question version", { ...ENABLED_RAW, questionVersion: "v2" }],
		["a bad policy version", { ...ENABLED_RAW, policyVersion: "v2" }],
		["a too-short timeout", { ...ENABLED_RAW, timeoutMs: 499 }],
		["a fractional timeout", { ...ENABLED_RAW, timeoutMs: 1000.5 }],
		["an unknown key", { ...ENABLED_RAW, apiKey: "x" }],
		[
			"an unknown consent key",
			{
				...ENABLED_RAW,
				consent: { ...ENABLED_RAW.consent, extra: true },
			},
		],
		["a bad version", { ...ENABLED_RAW, version: 2 }],
		[
			"a disabled section with extra keys",
			{ version: 1, enabled: false, timeoutMs: 1000 },
		],
		["a non-object", "on"],
		["null", null],
	] as const) {
		it(`rejects ${label}`, () => {
			assert.throws(
				() => parseJevRouterConfig(raw),
				/Invalid subagent jevRouter config/,
			);
			const loaded = loadJevRouterConfig(
				configFile(JSON.stringify({ jevRouter: raw })),
			);
			assert.equal(loaded.status, "invalid");
		});
	}

	it("rejects duplicate members, including a repeated section", () => {
		const nested = `{"jevRouter":{"version":1,"enabled":false,"enabled":false}}`;
		assert.equal(findDuplicateJevRouterMember(nested), "jevRouter.enabled");
		const repeated = `{"jevRouter":{"version":1,"enabled":false},"jevRouter":{"version":1,"enabled":false}}`;
		assert.equal(findDuplicateJevRouterMember(repeated), "jevRouter");
		assert.equal(loadJevRouterConfig(configFile(nested)).status, "invalid");
		assert.equal(loadJevRouterConfig(configFile(repeated)).status, "invalid");
	});

	it("keeps the automatic scanner's behavior for autoRouting", () => {
		assert.equal(
			findDuplicateAutoRoutingMember(
				`{"autoRouting":{"mode":"off","mode":"off"}}`,
			),
			"autoRouting.mode",
		);
		assert.equal(
			findDuplicateAutoRoutingMember(`{"jevRouter":{"a":1,"a":2}}`),
			undefined,
		);
		assert.equal(
			findDuplicateJevRouterMember(
				`{"autoRouting":{"mode":"off","mode":"off"}}`,
			),
			undefined,
		);
	});

	it("is independent of autoRouting and never reads authentication", () => {
		const loaded = loadJevRouterConfig(
			configFile(
				JSON.stringify({
					autoRouting: { version: 1, mode: "off" },
					jevRouter: ENABLED_RAW,
				}),
			),
		);
		assert.equal(loaded.status, "enabled");
	});
});

describe("task model writer and jevRouter", () => {
	const tasks: TaskPreferences = { coding: ["fake/model"] };
	const meta = {
		generatedAt: "2026-10-05T00:00:00Z",
		method: "registry-only" as const,
	};

	it("preserves advisory consent and settings", () => {
		const path = configFile(JSON.stringify({ jevRouter: ENABLED_RAW }));
		writeTaskModelConfig(path, path, tasks, meta, () => true);
		assert.deepEqual(
			JSON.parse(readFileSync(path, "utf8")).jevRouter,
			ENABLED_RAW,
		);
	});

	it("refuses to rewrite a config with a repeated jevRouter section", () => {
		const section = `"jevRouter":{"version":1,"enabled":false}`;
		const text = `{${section},${section}}`;
		const path = configFile(text);
		assert.throws(
			() => writeTaskModelConfig(path, path, tasks, meta, () => true),
			/jevRouter is a duplicate JSON member/,
		);
		assert.equal(readFileSync(path, "utf8"), text);
	});

	it("preserves a disabled advisory section and unrelated autoRouting verbatim", () => {
		const raw = {
			autoRouting: { version: 1, mode: "off" },
			jevRouter: { version: 1, enabled: false },
		};
		const path = configFile(JSON.stringify(raw));
		writeTaskModelConfig(path, path, tasks, meta, () => true);
		const written = JSON.parse(readFileSync(path, "utf8"));
		assert.deepEqual(written.jevRouter, raw.jevRouter);
		assert.deepEqual(written.autoRouting, raw.autoRouting);
		assert.deepEqual(written.models.tasks, tasks);
	});

	it("refuses to rewrite a config with duplicate advisory members", () => {
		const text = `{"jevRouter":{"version":1,"enabled":false,"enabled":true}}`;
		const path = configFile(text);
		assert.throws(
			() => writeTaskModelConfig(path, path, tasks, meta, () => true),
			/jevRouter.*duplicate JSON member/,
		);
		assert.equal(readFileSync(path, "utf8"), text);
	});
});
