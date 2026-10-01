import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	loadRouteConfig,
	parseRouteConfig,
	type Route,
	selectRouteCandidate,
} from "../pi-extension/subagents/route-config.ts";

const review = {
	description: "Code review of a finished change",
	candidates: [
		{
			agent: "reviewer",
			harness: "pi",
			model: "openai-codex/gpt-6-astra",
			thinking: "high",
		},
		{
			agent: "reviewer",
			harness: "claude",
			model: "opus",
			thinking: "high",
		},
	],
};

function candidate(overrides: Record<string, string>) {
	return {
		routes: { r: { candidates: [{ ...review.candidates[0], ...overrides }] } },
	};
}

describe("route config", () => {
	it("is empty when the routes section is absent", () => {
		assert.deepEqual(parseRouteConfig({ models: {} }), { routes: {} });
	});

	it("parses ordered role/harness/model/thinking candidates", () => {
		assert.deepEqual(parseRouteConfig({ routes: { review } }), {
			routes: { review },
		});
	});

	it("loads routes from the config file and tolerates a missing file", () => {
		const dir = mkdtempSync(join(tmpdir(), "routes-"));
		try {
			const path = join(dir, "config.json");
			assert.deepEqual(loadRouteConfig(path), { routes: {} });
			writeFileSync(path, JSON.stringify({ routes: { review } }));
			assert.deepEqual(Object.keys(loadRouteConfig(path).routes), ["review"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects malformed routes before any launch", () => {
		for (const [config, message] of [
			[{ routes: [] }, /routes must be an object/],
			[{ routes: { Review: review } }, /name must match/],
			[{ routes: { r: { candidates: [] } } }, /1-16 candidates/],
			[
				{ routes: { r: { ...review, extra: 1 } } },
				/unsupported key\(s\): extra/,
			],
			[candidate({ harness: "codex" }), /harness must be pi, claude, or kiro/],
			[
				candidate({ model: "gpt-6-astra" }),
				/provider\/model-id for harness pi/,
			],
			[candidate({ model: "a/b, c/d" }), /one exact model/],
			[candidate({ model: "task:review" }), /one exact model/],
			[candidate({ thinking: "huge" }), /thinking must be one of/],
			[
				candidate({
					harness: "kiro",
					model: "claude-opus-5",
					thinking: "minimal",
				}),
				/low through max for native harness kiro/,
			],
			[
				{
					routes: {
						r: { candidates: [review.candidates[0], review.candidates[0]] },
					},
				},
				/duplicates an earlier candidate/,
			],
		] as const) {
			assert.throws(() => parseRouteConfig(config), message);
		}
	});
});

describe("route candidate selection", () => {
	const { routes } = parseRouteConfig({ routes: { review } });
	const route: Route = routes.review;

	it("keeps the first candidate that prepares", () => {
		const selection = selectRouteCandidate(route, (c) => ({
			ok: true,
			value: c.harness,
		}));
		assert.ok("candidate" in selection);
		assert.equal(selection.index, 0);
		assert.equal(selection.value, "pi");
		assert.deepEqual(selection.skipped, []);
	});

	it("skips rejected or throwing candidates and reports why", () => {
		const selection = selectRouteCandidate(route, (c) => {
			if (c.harness === "pi") throw new Error("model not authenticated");
			return { ok: true, value: c.model };
		});
		assert.ok("candidate" in selection);
		assert.equal(selection.value, "opus");
		assert.deepEqual(
			selection.skipped.map(({ reason }) => reason),
			["model not authenticated"],
		);
	});

	it("reports every candidate when none can launch", () => {
		const selection = selectRouteCandidate(route, () => ({
			ok: false,
			reason: "unavailable",
		}));
		assert.ok(!("candidate" in selection));
		assert.equal(selection.skipped.length, 2);
	});
});
