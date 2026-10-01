import { pathToFileURL } from "node:url";
import { autoEffortBand } from "../../pi-extension/subagents/auto-routing-policy.ts";
import { digest, loadBundle, validateBundle } from "./jev-routing-validate.mjs";

/** Every rate carries its denominator; an empty denominator is null, not 0. */
function rate(numerator, denominator) {
	return {
		numerator,
		denominator,
		value: denominator === 0 ? null : numerator / denominator,
	};
}
/** Deterministic nearest-rank percentiles, including one-element samples. */
export function percentiles(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (p) =>
		sorted.length === 0 ? null : sorted[Math.ceil(p * sorted.length) - 1];
	return {
		samples: sorted.length,
		p50: at(0.5),
		p95: at(0.95),
		p99: at(0.99),
		method: "nearest-rank",
	};
}
function availability(values) {
	const known = values.filter((value) => value !== null);
	return {
		samples: values.length,
		available: known.length,
		unknown: values.length - known.length,
		knownSubtotal: known.length === 0 ? null : known.reduce((a, b) => a + b, 0),
		total:
			values.length === 0 || known.length !== values.length
				? null
				: known.reduce((a, b) => a + b, 0),
	};
}
function groupDisagreement(cases, dimension) {
	const grouped = new Map();
	for (const item of cases) {
		const labels =
			dimension === "language" ? [item.entry.language] : item.entry.categories;
		for (const label of labels) {
			const counts = grouped.get(label) ?? { numerator: 0, denominator: 0 };
			counts.denominator++;
			if (item.failures.length > 0) counts.numerator++;
			grouped.set(label, counts);
		}
	}
	return Object.fromEntries(
		[...grouped]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([label, counts]) => [
				label,
				rate(counts.numerator, counts.denominator),
			]),
	);
}
function summarize(cases, catalog) {
	const eligible = cases.filter((item) => item.policy.kind !== "bypass");
	const routed = eligible.filter((item) => item.record.host.kind === "route");
	const knownLaunches = cases.flatMap((item) => item.record.host.dispatches);
	const abstentions = {};
	const bypasses = {};
	for (const item of cases) {
		const h = item.record.host;
		if (h.kind === "abstain")
			abstentions[h.reason] = (abstentions[h.reason] ?? 0) + 1;
		if (h.kind === "bypass") bypasses[h.reason] = (bypasses[h.reason] ?? 0) + 1;
	}
	const batchRecords = cases.flatMap((item) =>
		Object.values(item.record.batches).filter((batch) => batch !== null),
	);
	const fullPairs = cases.filter(
		(item) => item.record.batches.A !== null && item.record.batches.B !== null,
	);
	const tierRanks = { fast: 0, mid: 1, frontier: 2 };
	const topTierJudged = routed.filter(
		(item) => item.entry.expected.maxTier !== null,
	);
	return {
		cases: cases.length,
		eligible: eligible.length,
		bypassed: cases.length - eligible.length,
		eligibleAbstained: eligible.filter(
			(item) => item.record.host.kind === "abstain",
		).length,
		unknownOutcomes: eligible.filter(
			(item) => item.record.host.kind === "unknown",
		).length,
		routeCoverage: rate(routed.length, eligible.length),
		conditionalRoleAccuracy: rate(
			routed.filter((item) =>
				item.entry.expected.roles.includes(item.record.host.tuple?.roleId),
			).length,
			routed.length,
		),
		tupleAccuracy: rate(
			routed.filter(
				(item) =>
					item.entry.expected.tupleIds.includes(item.record.host.candidateId) &&
					item.policy.kind === "route" &&
					item.policy.candidateId === item.record.host.candidateId &&
					!item.failures.includes("unauthorized-tuple") &&
					!item.failures.includes("route-dispatch-inconsistent"),
			).length,
			routed.length,
		),
		abstentionReasons: abstentions,
		bypassReasons: bypasses,
		underTierRate: rate(
			routed.filter((item) => {
				const tuple = item.record.host.tuple;
				return (
					tuple === null ||
					autoEffortBand(tuple.harness, tuple.effort) <
						item.entry.expected.minBand ||
					tierRanks[tuple.tier] < Math.min(item.entry.expected.minBand, 2)
				);
			}).length,
			routed.length,
		),
		unnecessaryTopTierRate: rate(
			topTierJudged.filter(
				(item) =>
					item.record.host.tuple?.tier === "frontier" &&
					item.entry.expected.maxTier !== "frontier",
			).length,
			topTierJudged.length,
		),
		unauthorizedLaunches: knownLaunches.filter(
			(tuple) =>
				!catalog.tuples.some((allowed) => digest(allowed) === digest(tuple)),
		).length,
		knownLaunches: knownLaunches.length,
		repeatedDispatchesPerLocalDecision: {
			decisions: cases.length,
			affectedDecisions: cases.filter(
				(item) => item.record.host.dispatches.length > 1,
			).length,
			excessDispatches: cases.reduce(
				(sum, item) =>
					sum + Math.max(0, item.record.host.dispatches.length - 1),
				0,
			),
			maximumKnownDispatches:
				cases.length === 0
					? null
					: Math.max(
							...cases.map((item) => item.record.host.dispatches.length),
						),
		},
		unknownDispatchDecisions: cases.filter(
			(item) => item.record.host.dispatchState === "unknown",
		).length,
		policyAgreement: rate(
			cases.filter(
				(item) => !item.failures.includes("distribution-policy-disagreement"),
			).length,
			cases.length,
		),
		disagreementByLanguage: groupDisagreement(cases, "language"),
		disagreementByCategory: groupDisagreement(cases, "category"),
		twoBatchLatencyMs: {
			...percentiles(
				fullPairs.map(
					(item) =>
						item.record.batches.A.telemetry.latencyMs +
						item.record.batches.B.telemetry.latencyMs,
				),
			),
			excludedDecisions: cases.length - fullPairs.length,
			scope:
				"completed A+B classifier batches only; excludes ownership/launch time",
		},
		batchTelemetry: {
			scope: "completed classifier batches, not child execution",
			batches: batchRecords.length,
			inputTokens: availability(
				batchRecords.map((batch) => batch.telemetry.inputTokens),
			),
			outputTokens: availability(
				batchRecords.map((batch) => batch.telemetry.outputTokens),
			),
			costUsd: availability(
				batchRecords.map((batch) => batch.telemetry.costUsd),
			),
		},
	};
}
export function scoreBundle(bundle) {
	const validation = validateBundle(bundle, { enforceSemantics: false });
	return {
		evidence:
			"synthetic mechanical fixtures, NOT live Jev quality or measured service latency",
		thresholdsStatus: "uncalibrated",
		versions: {
			catalog: bundle.catalog.version,
			cases: bundle.tune.version,
			answers: bundle.answers.version,
			pin: "jev-1.13.0",
			policy: "jev-auto-v1",
			questions: "jev-auto-questions-v1",
		},
		denominators:
			"Coverage: all current-view eligible decisions including unknowns. Role/tuple/under-tier: eligible host-routed decisions. Top-tier: host-routed decisions with a labeled tier ceiling. Disagreement: all decisions per label; multi-category cases contribute once per category. Dispatches: known dispatch receipts only, NOT host submissions or cross-process exactly-once.",
		aggregate: summarize(validation.cases, bundle.catalog),
		splits: Object.fromEntries(
			["tune", "heldout"].map((split) => [
				split,
				summarize(
					validation.cases.filter((item) => item.entry.split === split),
					bundle.catalog,
				),
			]),
		),
		violations: validation.violations,
	};
}
if (
	process.argv[1] &&
	pathToFileURL(process.argv[1]).href === import.meta.url
) {
	try {
		if (process.argv.length !== 2)
			throw new Error(
				"usage: node --experimental-strip-types test/evals/jev-routing-score.mjs",
			);
		const report = scoreBundle(await loadBundle());
		console.log(JSON.stringify(report, null, 2));
		if (report.violations.length > 0) process.exitCode = 1;
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
