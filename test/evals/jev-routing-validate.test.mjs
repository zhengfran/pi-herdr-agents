import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
	bindingFor,
	loadBundle,
	validateBundle,
} from "./jev-routing-validate.mjs";

const fixture = await loadBundle();
const fresh = () => structuredClone(fixture);
const firstRoute = (bundle) =>
	bundle.answers.records.find((record) => record.host.kind === "route");
const routeAs = (record, tuple) => {
	record.host.candidateId = tuple.id;
	record.host.tuple = structuredClone(tuple);
	record.host.dispatches = [structuredClone(tuple)];
};
function rebind(bundle, entry, split) {
	bundle.answers.records.find((record) => record.caseId === entry.id).binding =
		bindingFor(bundle.catalog, entry, split);
}

describe("offline Jev routing corpus validation", () => {
	it("registers only the offline eval command and uses the existing test glob once", async () => {
		const pkg = JSON.parse(
			await readFile(new URL("../../package.json", import.meta.url), "utf8"),
		);
		assert.equal(
			pkg.scripts["test:eval:jev-routing"],
			"node --experimental-strip-types test/evals/jev-routing-validate.mjs && node --experimental-strip-types test/evals/jev-routing-score.mjs",
		);
		assert.equal(pkg.scripts.test.split("test/evals/*.test.mjs").length - 1, 1);
		assert.ok(!pkg.scripts.test.includes("jev-routing-validate.test.mjs"));
		assert.ok(!pkg.scripts.test.includes("jev-routing-score.test.mjs"));
	});
	it("validates the pinned synthetic corpus and disjoint splits", () => {
		const result = validateBundle(fixture);
		assert.equal(result.cases.length, 97);
		assert.equal(fixture.tune.cases.length, 34);
		assert.equal(fixture.heldout.cases.length, 63);
		assert.equal(result.violations.length, 0);
		assert.equal(fixture.catalog.tuples.length, 20);
		assert.equal(
			new Set(result.cases.map((item) => item.entry.language)).size,
			7,
		);
	});
	it("includes the required calibration categories without promising original-view detection", () => {
		const categories = new Set(
			[...fixture.tune.cases, ...fixture.heldout.cases].flatMap(
				(entry) => entry.categories,
			),
		);
		for (const category of [
			"multilingual",
			"code-quotation",
			"log-quotation",
			"inspect-to-implement",
			"unread-source-clear-target",
			"ambiguous-pronoun",
			"manual-runtime",
			"manual-model",
			"local-file-reference",
			"prompt-injection",
			"capability-widening",
			"report-plan",
			"artifact-plan",
			"review-known-author",
			"review-unknown-author",
			"strict-review",
			"high-consequence-low-reasoning",
			"bimodal",
			"candidate-drift",
			"current-view-transform",
			"expanded-file-text",
			"upstream-image-removed",
			"non-tui-bypass",
			"streaming-bypass",
			"repeat-identical-input",
			"dispatch-unknown",
			"crash-before-ownership",
		])
			assert.ok(categories.has(category), category);
		const currentViewCases = fixture.answers.records.filter((record) =>
			[...fixture.tune.cases, ...fixture.heldout.cases]
				.find((entry) => entry.id === record.caseId)
				.categories.includes("upstream-image-removed"),
		);
		assert.ok(currentViewCases.every((record) => record.host.kind === "route"));
	});
	it("treats identical current inputs in one split as distinct local decisions", () => {
		const repeats = fixture.heldout.cases.filter((entry) =>
			entry.categories.includes("repeat-identical-input"),
		);
		assert.equal(repeats.length, 2);
		assert.equal(repeats[0].task, repeats[1].task);
		const records = fixture.answers.records.filter((record) =>
			repeats.some((entry) => entry.id === record.caseId),
		);
		assert.notEqual(records[0].decisionId, records[1].decisionId);
		assert.ok(records.every((record) => record.host.dispatches.length === 1));
	});
	it("rejects altered catalog tuple authorization even when IDs match", () => {
		const bundle = fresh();
		const record = firstRoute(bundle);
		record.host.tuple.model = "synthetic/unapproved-20260901";
		record.host.dispatches[0].model = record.host.tuple.model;
		assert.throws(() => validateBundle(bundle), /unauthorized-tuple/);
	});
	it("rejects repeated dispatches within one local decision", () => {
		const bundle = fresh();
		const record = firstRoute(bundle);
		record.host.dispatches.push(structuredClone(record.host.dispatches[0]));
		assert.throws(() => validateBundle(bundle), /repeated-dispatch/);
	});
	it("rejects duplicate case IDs, decision IDs, and missing answers", () => {
		for (const mutate of [
			(bundle) => {
				bundle.tune.cases[1].id = bundle.tune.cases[0].id;
			},
			(bundle) => {
				bundle.answers.records[1].decisionId =
					bundle.answers.records[0].decisionId;
			},
			(bundle) => {
				bundle.answers.records[1].caseId = bundle.answers.records[0].caseId;
			},
			(bundle) => {
				bundle.answers.records.pop();
			},
		]) {
			const bundle = fresh();
			mutate(bundle);
			assert.throws(
				() => validateBundle(bundle),
				/duplicate|one record per case/,
			);
		}
	});
	it("rejects ID split leakage and renamed current-view input leakage", () => {
		const bundle = fresh();
		bundle.heldout.cases[0].id = bundle.tune.cases[0].id;
		assert.throws(() => validateBundle(bundle), /split leakage/);
		const renamed = fresh();
		const entry = renamed.heldout.cases[0];
		entry.task = renamed.tune.cases[0].task;
		entry.view = structuredClone(renamed.tune.cases[0].view);
		entry.scenario = renamed.tune.cases[0].scenario;
		rebind(renamed, entry, "heldout");
		assert.throws(() => validateBundle(renamed), /current-view input leakage/);
	});
	it("rejects every missing or unknown key at the primary schema boundaries", () => {
		for (const locate of [
			(bundle) => bundle,
			(bundle) => bundle.catalog,
			(bundle) => bundle.catalog.roles[0],
			(bundle) => bundle.catalog.tuples[0],
			(bundle) => bundle.tune,
			(bundle) => bundle.tune.cases[0],
			(bundle) => bundle.tune.cases[0].view,
			(bundle) => bundle.tune.cases[0].expected,
			(bundle) => bundle.answers,
			(bundle) => bundle.answers.records[0],
			(bundle) => bundle.answers.records[0].binding,
			(bundle) => bundle.answers.records[0].batches,
			(bundle) => bundle.answers.records[0].batches.A,
			(bundle) => bundle.answers.records[0].batches.A.telemetry,
			(bundle) => bundle.answers.records[0].host,
		]) {
			const bundle = fresh();
			locate(bundle).unexpected = true;
			assert.throws(() => validateBundle(bundle), /unknown\/missing/);
			const missing = fresh();
			const target = locate(missing);
			delete target[Object.keys(target)[0]];
			assert.throws(() => validateBundle(missing));
		}
	});
	it("rejects partial, extra, negative, over-one, nonfinite, and bad-sum distributions", () => {
		for (const question of ["role", "reasoning", "consequence"]) {
			for (const mutate of [
				(p) => {
					delete p[Object.keys(p)[0]];
				},
				(p) => {
					p.unoffered = 0;
				},
				(p) => {
					p[Object.keys(p)[0]] = -0.01;
				},
				(p) => {
					p[Object.keys(p)[0]] = 1.01;
				},
				(p) => {
					p[Object.keys(p)[0]] = Number.NaN;
				},
				(p) => {
					p[Object.keys(p)[0]] = Infinity;
				},
				(p) => {
					p[Object.keys(p)[0]] = "0.5";
				},
				(p) => {
					for (const key of Object.keys(p)) p[key] = 0;
				},
			]) {
				const bundle = fresh();
				mutate(
					bundle.answers.records[0].batches.A.wire.answers[question]
						.probabilities,
				);
				assert.throws(() => validateBundle(bundle), /evidence:/);
			}
		}
	});
	it("rejects partial or out-of-range Batch B distributions and confidence", () => {
		for (const question of ["runtime", "model_pi", "model_claude"]) {
			for (const mutate of [
				(answer) => {
					delete answer.probabilities[Object.keys(answer.probabilities)[0]];
				},
				(answer) => {
					answer.probabilities.extra = 0;
				},
				(answer) => {
					answer.probabilities[Object.keys(answer.probabilities)[0]] = -0.5;
				},
				(answer) => {
					answer.confidence = 2;
				},
			]) {
				const bundle = fresh();
				mutate(bundle.answers.records[0].batches.B.wire.answers[question]);
				assert.throws(() => validateBundle(bundle), /evidence:/);
			}
		}
	});
	it("covers every non-TUI/source/streaming combination with zero evidence and dispatch", () => {
		const result = validateBundle(fixture).cases;
		for (const mode of ["tui", "rpc", "json", "print"])
			for (const source of ["interactive", "rpc", "extension"])
				for (const streaming of [null, "steer", "followUp"]) {
					if (mode === "tui" && source === "interactive" && streaming === null)
						continue;
					const example = result.find(
						({ entry }) =>
							entry.view.mode === mode &&
							entry.view.source === source &&
							entry.view.streaming === streaming,
					);
					assert.ok(example, `${mode}/${source}/${streaming}`);
					assert.equal(example.policy.kind, "bypass");
					assert.equal(example.record.batches.A, null);
					assert.equal(example.record.batches.B, null);
					assert.equal(example.record.host.dispatches.length, 0);
				}
	});
	it("rejects malformed confidence, Noul, mean, legend, answer choice, and unknown wire keys", () => {
		for (const mutate of [
			(wire) => {
				wire.answers.role.confidence = 1.1;
			},
			(wire) => {
				wire.answers.reasoning.confidence = null;
			},
			(wire) => {
				wire.answers.mutation_requested.noul = -1;
			},
			(wire) => {
				wire.answers.reasoning.score = 3;
			},
			(wire) => {
				wire.answers.reasoning.legend["0"] = "altered rubric";
			},
			(wire) => {
				wire.answers.role.choice = "none";
			},
			(wire) => {
				delete wire.answers.role;
			},
			(wire) => {
				wire.answers.extra = { type: "noul", noul: 0 };
			},
			(wire) => {
				wire.extra = true;
			},
			(wire) => {
				wire.usage.extra = 0;
			},
		]) {
			const bundle = fresh();
			mutate(bundle.answers.records[0].batches.A.wire);
			assert.throws(() => validateBundle(bundle), /evidence:/);
		}
	});
	it("rejects altered pin/question/policy/catalog/case versions and content", () => {
		for (const key of Object.keys(fixture.answers.records[0].binding)) {
			const bundle = fresh();
			bundle.answers.records[0].binding[key] += "-changed";
			assert.throws(() => validateBundle(bundle), /binding/);
		}
		const changedTask = fresh();
		changedTask.tune.cases[0].task += " Alter the deliverable.";
		assert.throws(() => validateBundle(changedTask), /binding/);
		const changedCatalog = fresh();
		changedCatalog.catalog.tuples[0].family = "other-family";
		assert.throws(() => validateBundle(changedCatalog), /binding/);
		const changedPin = fresh();
		changedPin.answers.records[0].batches.A.wire.model = "jev-latest";
		assert.throws(() => validateBundle(changedPin), /pinned model/);
	});
	it("rejects role mismatch, mutation mismatch, and under-tier host tuples", () => {
		const wrongRole = fresh();
		routeAs(
			firstRoute(wrongRole),
			wrongRole.catalog.tuples.find((tuple) => tuple.roleId === "r01"),
		);
		assert.throws(
			() => validateBundle(wrongRole),
			/role-mismatch.*mutation-mismatch/,
		);
		const under = fresh();
		const record = under.answers.records.find(
			(r) => r.host.kind === "route" && r.host.requiredBand === 3,
		);
		routeAs(
			record,
			under.catalog.tuples.find(
				(tuple) =>
					tuple.roleId === record.host.tuple.roleId && tuple.tier === "fast",
			),
		);
		assert.throws(() => validateBundle(under), /under-tier/);
	});
	it("rejects routed bypasses and classifier evidence on bypass", () => {
		const bundle = fresh();
		const bypass = bundle.answers.records.find(
			(record) => record.host.kind === "bypass",
		);
		bypass.host.dispatches = structuredClone(
			firstRoute(bundle).host.dispatches,
		);
		assert.throws(() => validateBundle(bundle), /bypass-routed/);
		const classifiedBypass = fresh();
		classifiedBypass.answers.records.find(
			(record) => record.host.kind === "bypass",
		).batches.A = structuredClone(
			classifiedBypass.answers.records[0].batches.A,
		);
		assert.throws(
			() => validateBundle(classifiedBypass),
			/zero classifier batches/,
		);
	});
	it("never treats user-prose author provenance as review authorization", () => {
		const bundle = fresh();
		const entry = bundle.heldout.cases.find(
			(entry) =>
				entry.categories.includes("strict-review") &&
				entry.expected.authorFamily !== null,
		);
		const record = bundle.answers.records.find(
			(record) => record.caseId === entry.id,
		);
		record.host.kind = "route";
		record.host.reason = null;
		routeAs(
			record,
			bundle.catalog.tuples.find((tuple) => tuple.roleId === "r03"),
		);
		assert.throws(() => validateBundle(bundle), /independence-violation/);
	});
	it("rejects guessing no dispatch or replaying crash/unknown work", () => {
		const bundle = fresh();
		bundle.answers.records.find(
			(record) => record.host.kind === "unknown",
		).host.dispatchState = "known";
		assert.throws(() => validateBundle(bundle), /unknown-replayed-or-guessed/);
		const replayed = fresh();
		replayed.answers.records.find(
			(record) => record.host.kind === "unknown",
		).host.dispatches = structuredClone(firstRoute(replayed).host.dispatches);
		assert.throws(
			() => validateBundle(replayed),
			/unknown-replayed-or-guessed/,
		);
	});
	it("enforces catalog and telemetry bounds and rejects malformed tuple effort", () => {
		for (const mutate of [
			(bundle) => {
				bundle.catalog.tuples.push(structuredClone(bundle.catalog.tuples[0]));
			},
			(bundle) => {
				bundle.catalog.tuples[4].effort = "off";
			},
			(bundle) => {
				bundle.catalog.tuples[4].model = "invalid native id 20260901";
			},
			(bundle) => {
				bundle.answers.records[0].batches.A.telemetry.latencyMs = -1;
			},
			(bundle) => {
				bundle.answers.records[0].batches.A.telemetry.costUsd = Infinity;
			},
			(bundle) => {
				bundle.answers.records[0].batches.A.telemetry.inputTokens = 1;
			},
			(bundle) => {
				bundle.tune.cases[0].view.images = 17;
			},
			(bundle) => {
				bundle.catalog.roles[0].responsibility = "x".repeat(257);
			},
		]) {
			const bundle = fresh();
			mutate(bundle);
			assert.throws(() => validateBundle(bundle));
		}
	});
});
