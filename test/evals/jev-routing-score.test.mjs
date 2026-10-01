import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_AUTO_ROUTING_THRESHOLDS } from "../../pi-extension/subagents/auto-routing-config.ts";
import {
	AUTO_EFFORT_TAIL_GUARD,
	decideAfterBatchA,
	deriveRequiredBand,
} from "../../pi-extension/subagents/auto-routing-policy.ts";
import {
	buildBatchA,
	buildBatchB,
} from "../../pi-extension/subagents/jev-questions.ts";
import { percentiles, scoreBundle } from "./jev-routing-score.mjs";
import {
	evidenceFor,
	loadBundle,
	replay,
	snapshotFor,
	validateBundle,
} from "./jev-routing-validate.mjs";

const fixture = await loadBundle();
const fresh = () => structuredClone(fixture);
const firstRoute = (bundle) =>
	bundle.answers.records.find((record) => record.host.kind === "route");
function routeAs(record, tuple) {
	record.host.candidateId = tuple.id;
	record.host.tuple = structuredClone(tuple);
	record.host.dispatches = [structuredClone(tuple)];
}

/** Rebuild every B option from the actual surviving production candidate plan. */
function replayWithFreshBatchB(catalog, entry, record) {
	const snapshot = snapshotFor(catalog, entry, record.decisionId);
	const builtA = buildBatchA(snapshot);
	assert.equal(builtA.ok, true);
	const evidence = evidenceFor(builtA.batch, record.batches.A.wire);
	const outcome = decideAfterBatchA(
		snapshot,
		evidence,
		DEFAULT_AUTO_ROUTING_THRESHOLDS,
	);
	assert.equal(outcome.kind, "continue");
	const builtB = buildBatchB(outcome.plan);
	assert.equal(builtB.ok, true);
	const answers = {};
	for (const question of builtB.batch.expected) {
		assert.equal(question.type, "choice");
		const choice = question.id === "runtime" ? "pi" : question.options[0];
		answers[question.id] = {
			type: "choice",
			choice,
			probabilities: Object.fromEntries(
				question.options.map((option) => [
					option,
					option === choice ? 0.95 : option === "none" ? 0.05 : 0,
				]),
			),
			confidence: 0.95,
		};
	}
	record.batches.B.wire = { ...record.batches.B.wire, answers };
	return {
		evidence,
		plan: outcome.plan,
		policy: replay(catalog, entry, record),
	};
}

describe("offline Jev distribution and host-tuple scoring", () => {
	it("reports exact synthetic counts, denominators, and uncalibrated status", () => {
		const report = scoreBundle(fixture);
		assert.equal(report.thresholdsStatus, "uncalibrated");
		assert.match(report.evidence, /NOT live Jev quality/);
		assert.deepEqual(report.aggregate.routeCoverage, {
			numerator: 25,
			denominator: 50,
			value: 0.5,
		});
		assert.deepEqual(report.aggregate.conditionalRoleAccuracy, {
			numerator: 25,
			denominator: 25,
			value: 1,
		});
		assert.deepEqual(report.aggregate.tupleAccuracy, {
			numerator: 25,
			denominator: 25,
			value: 1,
		});
		assert.equal(report.aggregate.eligibleAbstained, 21);
		assert.equal(report.aggregate.bypassed, 47);
		assert.equal(report.aggregate.unknownOutcomes, 4);
		assert.equal(report.aggregate.unauthorizedLaunches, 0);
		assert.equal(
			report.aggregate.repeatedDispatchesPerLocalDecision.excessDispatches,
			0,
		);
		assert.equal(report.violations.length, 0);
		assert.equal(report.splits.tune.routeCoverage.numerator, 12);
		assert.equal(report.splits.heldout.routeCoverage.numerator, 13);
	});
	it("reports deterministic nearest-rank two-batch latency, not sums of percentiles", () => {
		const latency = scoreBundle(fixture).aggregate.twoBatchLatencyMs;
		assert.equal(latency.samples, 30);
		assert.equal(latency.p50, 47);
		assert.equal(latency.p95, 57);
		assert.equal(latency.p99, 59);
		assert.equal(latency.excludedDecisions, 67);
		assert.deepEqual(percentiles([]), {
			samples: 0,
			p50: null,
			p95: null,
			p99: null,
			method: "nearest-rank",
		});
		assert.deepEqual(percentiles([9]), {
			samples: 1,
			p50: 9,
			p95: 9,
			p99: 9,
			method: "nearest-rank",
		});
		const bundle = fresh();
		const pairs = bundle.answers.records.filter(
			(record) => record.batches.A && record.batches.B,
		);
		pairs.forEach((record, index) => {
			record.batches.A.telemetry.latencyMs = index % 2 === 0 ? 100 : 0;
			record.batches.B.telemetry.latencyMs = index % 2 === 0 ? 0 : 100;
		});
		assert.equal(scoreBundle(bundle).aggregate.twoBatchLatencyMs.p99, 100);
	});
	it("distinguishes missing token/cost telemetry from a known zero price", () => {
		const telemetry = scoreBundle(fixture).aggregate.batchTelemetry;
		assert.equal(telemetry.batches, 78);
		assert.deepEqual(telemetry.costUsd, {
			samples: 78,
			available: 12,
			unknown: 66,
			knownSubtotal: 0,
			total: null,
		});
		assert.deepEqual(telemetry.inputTokens, {
			samples: 78,
			available: 78,
			unknown: 0,
			knownSubtotal: 9064,
			total: 9064,
		});
		assert.deepEqual(telemetry.outputTokens, {
			samples: 78,
			available: 78,
			unknown: 0,
			knownSubtotal: 2040,
			total: 2040,
		});
		const missingTokens = fresh();
		missingTokens.answers.records[0].batches.A.telemetry.inputTokens = null;
		missingTokens.answers.records[0].batches.A.telemetry.outputTokens = null;
		const partial = scoreBundle(missingTokens).aggregate.batchTelemetry;
		assert.equal(partial.inputTokens.unknown, 1);
		assert.equal(partial.inputTokens.total, null);
		assert.equal(partial.outputTokens.unknown, 1);
		assert.equal(partial.outputTokens.total, null);
		const bundle = fresh();
		for (const record of bundle.answers.records)
			for (const batch of Object.values(record.batches))
				if (batch) batch.telemetry.costUsd = null;
		const unknown = scoreBundle(bundle).aggregate.batchTelemetry.costUsd;
		assert.equal(unknown.available, 0);
		assert.equal(unknown.knownSubtotal, null);
		assert.equal(unknown.total, null);
		for (const record of bundle.answers.records)
			for (const batch of Object.values(record.batches))
				if (batch) batch.telemetry.costUsd = 0;
		assert.equal(scoreBundle(bundle).aggregate.batchTelemetry.costUsd.total, 0);
	});
	it("uses null rates and telemetry for an empty evaluation", () => {
		const bundle = fresh();
		bundle.tune.cases = [];
		bundle.heldout.cases = [];
		bundle.answers.records = [];
		const result = scoreBundle(bundle).aggregate;
		for (const metric of [
			"routeCoverage",
			"conditionalRoleAccuracy",
			"tupleAccuracy",
			"underTierRate",
			"unnecessaryTopTierRate",
			"policyAgreement",
		])
			assert.deepEqual(result[metric], {
				numerator: 0,
				denominator: 0,
				value: null,
			});
		assert.equal(result.twoBatchLatencyMs.p99, null);
		assert.equal(result.batchTelemetry.costUsd.total, null);
		assert.equal(
			result.repeatedDispatchesPerLocalDecision.maximumKnownDispatches,
			null,
		);
	});
	it("scores unauthorized and repeated known launches without hiding unknown dispatches", () => {
		const bundle = fresh();
		const record = firstRoute(bundle);
		record.host.dispatches[0].model = "synthetic/unauthorized-20260901";
		record.host.dispatches.push(structuredClone(record.host.dispatches[0]));
		const result = scoreBundle(bundle).aggregate;
		assert.equal(result.unauthorizedLaunches, 2);
		assert.equal(result.repeatedDispatchesPerLocalDecision.excessDispatches, 1);
		assert.equal(
			result.repeatedDispatchesPerLocalDecision.affectedDecisions,
			1,
		);
		assert.equal(
			result.repeatedDispatchesPerLocalDecision.maximumKnownDispatches,
			2,
		);
		assert.equal(result.unknownDispatchDecisions, 4);
		assert.equal(result.knownLaunches, 26);
	});
	it("counts role/tuple mismatch and disagreement by language and category", () => {
		const bundle = fresh();
		const record = firstRoute(bundle);
		routeAs(
			record,
			bundle.catalog.tuples.find((tuple) => tuple.roleId === "r01"),
		);
		const report = scoreBundle(bundle);
		assert.equal(report.aggregate.conditionalRoleAccuracy.numerator, 24);
		assert.equal(report.aggregate.tupleAccuracy.numerator, 24);
		assert.equal(report.aggregate.disagreementByLanguage.en.numerator, 1);
		assert.equal(
			report.aggregate.disagreementByCategory["code-quotation"].numerator,
			1,
		);
		assert.equal(report.aggregate.disagreementByLanguage.ar.numerator, 0);
		assert.equal(report.splits.heldout.conditionalRoleAccuracy.value, 1);
	});
	it("scores under-tier effort and unnecessary frontier use independently", () => {
		const bundle = fresh();
		const top = bundle.answers.records.find(
			(record) =>
				record.host.kind === "route" && record.host.requiredBand === 3,
		);
		routeAs(
			top,
			bundle.catalog.tuples.find(
				(tuple) =>
					tuple.roleId === top.host.tuple.roleId && tuple.tier === "fast",
			),
		);
		assert.equal(scoreBundle(bundle).aggregate.underTierRate.numerator, 1);
		const excessive = fresh();
		const easy = firstRoute(excessive);
		routeAs(
			easy,
			excessive.catalog.tuples.find(
				(tuple) =>
					tuple.roleId === easy.host.tuple.roleId && tuple.tier === "frontier",
			),
		);
		assert.equal(
			scoreBundle(excessive).aggregate.unnecessaryTopTierRate.numerator,
			1,
		);
		assert.equal(scoreBundle(excessive).aggregate.underTierRate.numerator, 0);
	});
	it("keeps bypass launches out of eligible coverage but reports their violation", () => {
		const bundle = fresh();
		const bypass = bundle.answers.records.find(
			(record) => record.host.kind === "bypass",
		);
		bypass.host.kind = "route";
		bypass.host.reason = null;
		routeAs(bypass, firstRoute(bundle).host.tuple);
		const report = scoreBundle(bundle);
		assert.deepEqual(report.aggregate.routeCoverage, {
			numerator: 25,
			denominator: 50,
			value: 0.5,
		});
		assert.equal(report.aggregate.knownLaunches, 26);
		assert.ok(report.violations.some((v) => v.caseId === bypass.caseId));
	});
	it("distinguishes identical Score means with bimodal versus central mass", () => {
		const results = validateBundle(fixture).cases;
		const bimodal = results.find(
			(item) =>
				item.entry.categories.includes("bimodal") &&
				item.entry.split === "tune",
		);
		const central = results.find((item) =>
			item.entry.categories.includes("unimodal"),
		);
		assert.equal(
			bimodal.record.batches.A.wire.answers.reasoning.score,
			central.record.batches.A.wire.answers.reasoning.score,
		);
		assert.equal(bimodal.policy.requiredBand, 3);
		assert.equal(central.policy.requiredBand, 2);
		assert.notEqual(bimodal.policy.candidateId, central.policy.candidateId);
	});
	it("isolates the exact inclusive level-3 tail guard from quantile and confidence escalation", () => {
		const bundle = fresh();
		const entry = bundle.heldout.cases.find(
			(entry) => entry.id === "heldout-014",
		);
		const record = bundle.answers.records.find(
			(record) => record.caseId === entry.id,
		);
		const scores = record.batches.A.wire.answers;
		assert.deepEqual(scores.reasoning.probabilities, {
			0: 1,
			1: 0,
			2: 0,
			3: 0,
		});
		assert.deepEqual(scores.consequence.probabilities, {
			0: 0.9,
			1: 0,
			2: 0,
			3: 0.1,
		});
		assert.equal(scores.consequence.probabilities["3"], AUTO_EFFORT_TAIL_GUARD);
		assert.ok(
			scores.reasoning.confidence >=
				DEFAULT_AUTO_ROUTING_THRESHOLDS.scoreConfidence,
		);
		assert.ok(
			scores.consequence.confidence >=
				DEFAULT_AUTO_ROUTING_THRESHOLDS.scoreConfidence,
		);
		const originalB = structuredClone(record.batches.B.wire);
		const baseline = replayWithFreshBatchB(bundle.catalog, entry, record);
		assert.deepEqual(record.batches.B.wire, originalB);
		assert.equal(
			deriveRequiredBand(
				baseline.evidence.scores.reasoning,
				baseline.evidence.scores.consequence,
				DEFAULT_AUTO_ROUTING_THRESHOLDS,
			),
			3,
		);
		assert.equal(baseline.policy.requiredBand, 3);
		assert.equal(baseline.policy.candidateId, "c003");
		// Only shift the consequence tail below 0.10; do not change either confidence.
		const below = AUTO_EFFORT_TAIL_GUARD - 0.000001;
		scores.consequence.probabilities["0"] = 1 - below;
		scores.consequence.probabilities["3"] = below;
		scores.consequence.score = 3 * below;
		const mutated = replayWithFreshBatchB(bundle.catalog, entry, record);
		assert.equal(mutated.plan.requiredBand, 0);
		assert.equal(mutated.policy.requiredBand, 0);
		assert.equal(mutated.policy.candidateId, "c000");
		assert.notDeepEqual(record.batches.B.wire.answers, originalB.answers);
	});
	it("isolates one low Score confidence at the strict floor without level-3 mass", () => {
		const bundle = fresh();
		const entry = bundle.heldout.cases.find(
			(entry) => entry.id === "heldout-015",
		);
		const record = bundle.answers.records.find(
			(record) => record.caseId === entry.id,
		);
		const scores = record.batches.A.wire.answers;
		assert.deepEqual(scores.reasoning.probabilities, {
			0: 0,
			1: 1,
			2: 0,
			3: 0,
		});
		assert.deepEqual(scores.consequence.probabilities, {
			0: 1,
			1: 0,
			2: 0,
			3: 0,
		});
		assert.equal(
			scores.reasoning.confidence,
			DEFAULT_AUTO_ROUTING_THRESHOLDS.scoreConfidence - 0.000001,
		);
		assert.ok(
			scores.consequence.confidence >=
				DEFAULT_AUTO_ROUTING_THRESHOLDS.scoreConfidence,
		);
		const originalB = structuredClone(record.batches.B.wire);
		const baseline = replayWithFreshBatchB(bundle.catalog, entry, record);
		assert.deepEqual(record.batches.B.wire, originalB);
		assert.equal(
			deriveRequiredBand(
				baseline.evidence.scores.reasoning,
				baseline.evidence.scores.consequence,
				DEFAULT_AUTO_ROUTING_THRESHOLDS,
			),
			3,
		);
		assert.equal(baseline.policy.requiredBand, 3);
		assert.equal(baseline.policy.candidateId, "c003");
		for (const confidence of [
			DEFAULT_AUTO_ROUTING_THRESHOLDS.scoreConfidence,
			DEFAULT_AUTO_ROUTING_THRESHOLDS.scoreConfidence + 0.000001,
		]) {
			// Perturb only reasoning confidence: consequence confidence and both distributions stay fixed.
			scores.reasoning.confidence = confidence;
			const mutated = replayWithFreshBatchB(bundle.catalog, entry, record);
			assert.equal(mutated.plan.requiredBand, 1);
			assert.equal(mutated.policy.requiredBand, 1);
			assert.equal(mutated.policy.candidateId, "c001");
			assert.notDeepEqual(record.batches.B.wire.answers, originalB.answers);
		}
	});
	it("uses full Choice distributions even when the chosen answer string is unchanged", () => {
		const bundle = fresh();
		const record = firstRoute(bundle);
		const answer = record.batches.A.wire.answers.role;
		const previous = answer.choice;
		answer.probabilities = { r00: 0.45, r01: 0.44, r02: 0, r03: 0, none: 0.11 };
		// The host incorrectly kept its old selection. A now abstains, so no B is allowed.
		record.batches.B = null;
		assert.equal(answer.choice, previous);
		const report = scoreBundle(bundle);
		assert.equal(report.aggregate.policyAgreement.numerator, 96);
		assert.equal(report.aggregate.tupleAccuracy.numerator, 24);
		assert.ok(
			report.violations.some(
				(v) => v.reason === "distribution-policy-disagreement",
			),
		);
	});
	it("supports unknown outcomes without interpreting them as zero work or replay", () => {
		const report = scoreBundle(fixture);
		assert.equal(report.aggregate.unknownOutcomes, 4);
		assert.equal(report.aggregate.unknownDispatchDecisions, 4);
		assert.equal(report.aggregate.routeCoverage.denominator, 50);
		assert.equal(
			report.aggregate.abstentionReasons["dispatch-uncertain"],
			undefined,
		);
	});
	it("rejects corrupt evidence instead of scoring answer strings or repairing probabilities", () => {
		const bundle = fresh();
		delete firstRoute(bundle).batches.B.wire.answers.runtime.probabilities.pi;
		assert.throws(() => scoreBundle(bundle), /evidence:/);
	});
	it("never consults fetch or classifier credentials while evaluating synthetic fixtures", () => {
		const previous = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = () => {
			calls++;
			throw new Error("network forbidden in offline eval");
		};
		try {
			validateBundle(fixture);
			scoreBundle(fixture);
			assert.equal(calls, 0);
		} finally {
			globalThis.fetch = previous;
		}
	});
});
