---
name: run-integration-tests
description: Run the integration test suite and verify all sessions end-to-end. Use when asked to run integration or e2e tests, test before release, or check everything works.
---

# Run integration tests

Run this workflow from inside herdr. This project supports no other terminal backend.

## Preflight

```bash
echo "HERDR_ENV=$HERDR_ENV"
command -v herdr
npm test
npm run test:eval:jev-routing
npm pack --dry-run
```

Stop and ask the user to start pi inside herdr if `HERDR_ENV` is not `1` or the CLI is missing.

## Integration suite

Run only one integration suite at a time on a Herdr instance. Before starting, confirm that no other checkout or agent is running `test/integration/*.test.ts`; concurrent suites compete for terminal focus and process capacity and can cause false timeouts or leaked test resources.

From the repository root, run the deterministic required suite:

```bash
npm run test:integration
```

The harness loads the extension directly from the working tree, creates isolated
test agents, and selects a local scripted provider. The automatic TUI suite also
isolates a test-owned Herdr server/HOME/PATH with fake classifier responses and
offline native executables; never resolve actual host Claude/Kiro for these probes.
This is the deterministic setup requirement, not a claim that all historical
implementation activity was network-free. Preserve prior incident evidence for
parent disclosure.

Automatic-routing focused commands from the repository root:

```bash
node --experimental-strip-types --test test/auto-routing-*.test.ts test/jev-client.test.ts test/jev-questions.test.ts
node --experimental-strip-types --test test/evals/jev-routing-*.test.mjs
npm run test:eval:jev-routing
# Real TUI; run sequentially, not alongside the full suite:
node --experimental-strip-types --test test/integration/auto-routing.test.ts
```

Use a parent unit-test environment without inherited `PI_SUBAGENT_ID` or
`PI_HERDR_AUTO_ROUTING_DISABLED`. Public-handler tests are not real TUI evidence:
the automatic integration submits actual idle editor text into a persisted parent
session and verifies on-disk request before dispatch and normal result/synthesis.
Fresh unpersisted input bypasses. Separate RPC/JSON/print processes prove bypass;
never substitute RPC prompts for TUI routing evidence.

The automatic suite is deterministic-only; live mode skips it. Pi 0.99.1 queued
idle `/subagents-routing cancel` and public `newSession` until the awaited input
resolved. Those two pre-dispatch scenarios are explicit blockers/skips, not passes.
Escape was observed reaching `jev-timeout`, not cancellation. Do not patch Pi or
replace private hooks to manufacture passes. The known BTW snapshot baseline
failure in `npm test` is also a disclosed failure, not passing evidence.

The eval script validates synthetic full-distribution fixtures only; no measured
Jev quality/latency or calibrated threshold claim follows. Never contact live Jev,
grant consent or enable routing for tests/releases. Shadow also needs consent.
Separate live capture requires explicit informed egress approval outside package
contents; see `docs/adr/0014-jev-auto-input-dispatch.md` and the README disclosure.

Integration tests must own and tear down their Herdr workspaces, processes, temporary repositories, and worktrees, including on failure. Wait for observable journal, pane, process, file, or screen conditions. Do not use a fixed sleep to synchronize a transition; deliberate elapsed-time scenarios are the exception.

Use this optional live-provider smoke test only when checking provider compatibility:

```bash
PI_TEST_MODEL="openai-codex/gpt-5.6-luna" PI_TEST_TIMEOUT=180000 npm run test:integration:live
```

Report passing, failing, and skipped tests. Do not claim full verification when Herdr-dependent tests were skipped. For package changes, inspect the dry-run contents for `CHANGELOG.md`,
`skills/orchestrate/SKILL.md`, `skills/orchestrate/adversarial-review.md` and
`skills/orchestrate/adversarial-review-example.js`. Confirm `workflow-worker.js`,
tests/evals/fixtures/generated captures, plans, journals, sessions, prototypes,
generated evidence, local config and `openspec/` are absent. The config example
must remain disabled/model-neutral without consent or tuples.

## Postflight

Capture workspace/process/residue inventories **before** starting as well as
afterward; distinguish baseline residue from new test-owned resources. The isolated
auto lab must stop its server/RPC/native processes and restore caller focus/inventory,
including on failure. Do not claim cleanup from test assertions alone.

```bash
git status --short
herdr workspace list
find "$HOME/.herdr/worktrees" "${TMPDIR:-/tmp}" /tmp -name 'pi-integ-*' -print 2>/dev/null
```

Confirm that no `pi-integ-*` workspace, process, temporary repository, or worktree remains. `herdr workspace list` already returns JSON. If a failed test leaves an artifact, verify that it is test-owned before removing it. Close a test-owned workspace with `herdr workspace close <workspace-id>`. Do not remove unrelated user workspaces, processes, files, or worktrees.
