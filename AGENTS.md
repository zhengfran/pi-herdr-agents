# Repository instructions for agents

These instructions apply to humans and coding agents changing `pi-herdr-agents`.

## What this package is

`pi-herdr-agents` (Pi Herdr Agents) is a Pi extension that launches asynchronous Pi child agents exclusively in Herdr. Ordinary runs group child panes in extension-owned `Agents` tabs by default. Writing tasks may opt into one isolated Herdr-managed Git worktree per branch. Roles may opt into a native Claude Code or Kiro harness with `cli: claude|kiro` in autonomous, interactive, or persistent mode, with exact-loadout resume, queued follow-ups, verified interrupts, fork/lineage context, Pi skills, native model fallback, and allowlisted nested delegation (ADR-0013). A spawn may run a named role on another harness with `harness: pi|claude|kiro` as a strictly validated role projection (explicit request → role `cli` → Pi). Unknown CLIs, unrepresentable native capabilities, and unrepresentable projections fail before Herdr creates resources.

Off-by-default automatic input routing uses public Pi 0.99.1 APIs, pinned Jev
evidence and durable administrator-approved exact tuples (ADR-0014). It admits
only eligible idle top-level TUI/interactive current-view input, undefined streaming
behavior, no current images and an existing persisted session. RPC/JSON/print,
extension-source and steer/followUp bypass; fresh unpersisted first prompts bypass.
Automatic children are shared-checkout standalone autonomous leaves, never
worktrees/forks/persistent/nested agents or review-purpose launches. Manual APIs
and task model preferences never enable/authorize auto. Shadow also sends data
and requires consent. Use [the canonical disclosure and operator contract](README.md#automatic-input-routing),
not stronger original-provenance, idle Escape, read-only or exactly-once claims.

A separate default-off `jevRouter` config enables the parent-only advisory
`jev_router` tool (README [Advisory route recommendation](README.md#advisory-route-recommendation-jev_router)):
it recommends configured route names from an explicit bounded brief, never launches,
and shares only `jev-transport.ts` with automatic routing. Keep it independent of
`autoRouting` consent, approvals, and question versions.

The extension is fire-and-forget: `subagent` returns an acknowledgement, and completion is delivered to the parent automatically. Never add polling guidance that tells callers to sleep, tail sessions, or repeatedly check status.

## Read these first

- [`README.md`](./README.md) — canonical installation, API, configuration, lifecycle, and agent-authoring reference
- [`docs/README.md`](docs/README.md) — map of shipped contracts, active design, ADRs, and background research
- [`CONTEXT.md`](CONTEXT.md) — workflow-domain glossary; read it before changing orchestration design
- [`docs/adr/0003-installable-role-packs.md`](docs/adr/0003-installable-role-packs.md) — installable role-pack discovery, precedence, and collision contract
- [`docs/worktree-subagents.md`](docs/worktree-subagents.md) — canonical worktree operating, review, recovery, and cleanup guide
- [`RELEASING.md`](RELEASING.md) — release checks and publishing procedure
- [`docs/adr/0014-jev-auto-input-dispatch.md`](docs/adr/0014-jev-auto-input-dispatch.md) — automatic evidence/authority, ownership, egress and residual host limits

Bundled role prompts live in [`agents/`](agents/). The native `/skill:orchestrate` public-review fan-out skill lives at [`skills/orchestrate/SKILL.md`](skills/orchestrate/SKILL.md). The `/plan` orchestration prompt lives at [`pi-extension/subagents/plan-skill.md`](pi-extension/subagents/plan-skill.md).

## Code map

- `pi-extension/subagents/index.ts` — public tools/commands, agent discovery, launch/watch lifecycle, completion delivery, worktree manifests and handoffs
- `pi-extension/subagents/herdr.ts` — Herdr CLI calls, response parsing, and ID-based Agents tab placement and capacity
- `pi-extension/subagents/terminal.ts` — terminal adapter used by the lifecycle
- `pi-extension/subagents/lifecycle.ts`, `status.ts`, `activity.ts` — process/turn state and widget projection
- `pi-extension/subagents/wake.ts`, `supervision.ts`, `supervision-config.ts` — file wake-ups, shared pane reconciliation, polling fallback, and supervision configuration
- `pi-extension/subagents/persistent-config.ts` — strict persistent-specialist cap configuration
- `pi-extension/subagents/auto-routing-{config,candidates,policy,input}.ts`, `jev-{questions,client}.ts` — strict durable approvals, local snapshots, full-distribution policy, current-view input ownership/persistence, and pinned authenticated classifier transport
- `pi-extension/subagents/jev-transport.ts`, `jev-router{,-config,-questions,-evidence,-policy,-auth}.ts` — generic bounded classifier transport (`jev-client.ts` is the automatic-v1 facade) and the advisory `jev_router` config, frozen questions, strict Choice decoder, conservative policy, and request-local key fallback
- `pi-extension/subagents/completion.ts`, `session.ts`, `subagent-done.ts` — child completion, transcript handling, `caller_ping`, and `subagent_done`
- `pi-extension/subagents/native-harness.ts`, `claude.ts`, `kiro.ts`, `process-run.ts`, `plugin/hooks/` — native `cli: claude|kiro` capability validation, pre-resource launch planning, owned hook/state files, correlated completion, and durable process receipts (ported from zhengfran/pi-interactive-subagents, MIT)
- `pi-extension/subagents/native-turns.ts` — harness-neutral tagged-turn driver: verified idle points, follow-up queue, interrupts, interactive/persistent/autonomous exit policy
- `pi-extension/subagents/native-session.ts` — v2 native session markers, loadout integrity, and the exclusive native session lease
- `pi-extension/subagents/native-context.ts` — typed-input sanitization, bounded untrusted fork context, and materialized Pi skills
- `pi-extension/subagents/kiro-mcp.ts`, `plugin/mcp/kiro-personal-mcp.py` — strict personal Kiro MCP selection, digest binding, and secret-free stdio proxy launch
- `pi-extension/subagents/native-bridge.ts`, `plugin/mcp/subagent-bridge.py` — authenticated nested-spawn bridge (signed requests, owner-token sender check) for `spawn-agents` roles
- `CONTEXT.md` — orchestration-domain glossary
- `docs/adr/` — hard-to-reverse architectural decisions
- `docs/research/` — evidence and alternatives, never the shipped contract
- `test/test.ts` — unit tests for public subagent extension seams
- `test/native-harness.test.ts`, `test/native-stage2.test.ts`, `test/native-flows.test.ts`, `test/native-regressions.test.ts` — native harness unit, end-to-end, and review-regression tests using offline `test/fixtures/native-bin/` CLI stand-ins, `test/native-fixtures.ts`, and `test/native-flow-harness.ts` (flows run through the extension's tool handlers with a fake Herdr test seam)
- `test/harness-selection.test.ts` — spawn-time harness selection and role projection through the public `subagent`/`subagent_resume` tools, `startSubagentRun`, and the registered `/subagent` command, using the fake Herdr seam and offline native fixtures
- `test/auto-routing-*.test.ts`, `test/jev-client.test.ts`, `test/jev-questions.test.ts` — offline contracts/public-handler flows (not real TUI evidence)
- `test/jev-router*.test.ts`, `test/jev-router-fixtures.ts` — offline advisory router contracts over the real Pi adapter with fake registry/fetch/key source
- `test/integration/auto-routing.test.ts` — isolated real TUI routing, real RPC/noninteractive bypass, fake classifier and offline native executables; deterministic-only, live skipped
- `test/evals/jev-routing-README.md` — synthetic uncalibrated fixtures/evaluator; no live capture
- `test/package-skill.test.js` — bundled skill and package manifest contract test
- `test/integration/` — real Herdr and Pi lifecycle tests using the deterministic provider by default
- `test/bench/supervision-bench.mjs` — manual isolated-Herdr supervision transport benchmark; raw samples stay in `/tmp/issue29-bench/`

## Worktree contract

Preserve these invariants when changing worktree behavior:

1. `worktree: { branch, base? }` is opt-in per `subagent` call.
2. `cwd` selects the source repository; the child starts at the created worktree root.
3. `base` resolves to an exact commit before creation and defaults to committed `HEAD`.
4. Parent uncommitted/untracked files are not copied.
5. An ownership manifest is written before Herdr resource creation.
6. Herdr creates the workspace without stealing focus; launch targets the returned root pane explicitly.
7. Successful, failed, and help-requesting runs retain their worktree workspace.
8. Completion reports reviewable Git state; inspection failures are unknown, never guessed clean or conflict-free.
9. The extension does not push, create PRs, merge, cherry-pick, switch the parent checkout, or remove worktrees automatically. Explicit parent-owned cleanup uses cwd containment and fail-closed eligibility; branches are never deleted.
10. Ordinary non-worktree subagent behavior remains unchanged.
11. A managed worktree is reused across native model fallback attempts only with positive evidence that the failed attempt never started its first turn (confirmed exit including descendants, a correlated session receipt with no prompt-submit receipt or hook error) and a pristine checkout; its durable lease stays parent-reserved across attempts, is handed to each attempt atomically, and is released only after the final attempt's confirmed exit. Native runs hold a durable `<manifest>.native-lease` that cleanup and resume honour after parent crashes.

Read [`docs/worktree-subagents.md`](docs/worktree-subagents.md) before changing any of these semantics.

## Orchestration guidance

- Use ordinary panes for read-only scouts and reviewers.
- A single or sequential writer can work in the parent checkout; reserve unique worktree branches for independent parallel writing tasks.
- Keep overlapping or dependent writing tasks sequential unless the dependency is committed and used as the next exact base.
- Tell worktree workers whether to commit. A good default is: edit, test, commit, report the SHA, and do not push/merge/remove.
- The parent owns review, integration, publication, and cleanup.
- Do not use `subagent_resume` as if it reattached worktree ownership; v1 resumes into an ordinary pane. A worktree-bound native marker resumes in an ordinary pane at the verified retained checkout and holds only its lease, never workspace ownership.
- Use `harness` only to run a portable named role on another runtime; a role that pins `model` needs an explicit destination model, and Pi and native model IDs never mix. Do not expect cross-harness fallback.
- Native (`cli: claude|kiro`) follow-ups go through `subagent_send` and are typed only at verified idle points; never type into a native pane yourself on the parent's behalf. Native resume replays the recorded loadout and cannot widen it.

## Documentation synchronization

When behavior changes, update every affected surface in the same commit:

- public tool parameters, role-pack protocol, or lifecycle → `README.md`
- automatic input/consent/config/ownership contract → `README.md`, ADR-0014 and affected contributor/policy surfaces; keep `config.json.example` disabled/model-neutral without consent or tuples
- role-pack discovery, precedence, or collision policy → `docs/adr/0003-installable-role-packs.md`
- worktree behavior, handoff, recovery, or cleanup → `docs/worktree-subagents.md`
- agent operating expectations → relevant files in `agents/`
- `/plan` orchestration policy → `pi-extension/subagents/plan-skill.md`
- contributor/release verification → this file, `.pi/skills/run-integration-tests/SKILL.md`, or `RELEASING.md`
- domain terminology → `CONTEXT.md`
- hard-to-reverse orchestration trade-offs → the relevant ADR; do not create an ADR for every design question
- architectural evidence and alternatives only → research docs, clearly marked when later decisions supersede them

Do not copy the full worktree guide into every role prompt. Keep canonical detail in the guide and add only the role-specific rule an agent needs while running.

## Verification

For normal changes:

```bash
npm test
npm run format:check
npm run lint
npm pack --dry-run
git diff --check
```

Run LSP diagnostics on every changed TypeScript file; lint and tests do not catch every TypeScript error.

Automatic-routing focused offline gates (use a parent test environment, not inherited
`PI_SUBAGENT_ID`/`PI_HERDR_AUTO_ROUTING_DISABLED`):

```bash
node --experimental-strip-types --test test/auto-routing-*.test.ts test/jev-client.test.ts test/jev-questions.test.ts
node --experimental-strip-types --test test/evals/jev-routing-*.test.mjs
npm run test:eval:jev-routing
```

The evaluator is synthetic mechanical evidence, not achieved Jev/execution-model
quality; thresholds remain uncalibrated. No network/live capture or automatic opt-in
belongs in these tests or release checks. Separate live capture requires explicit
egress approval outside the package.

For Herdr or lifecycle changes, run the deterministic suite from inside Herdr. `test/integration/native-harness.test.ts` drives the offline native fixtures through real Herdr panes; it needs no Claude or Kiro credentials and never contacts a model. Run only one integration suite at a time on a Herdr instance; concurrent suites compete for terminal focus and process capacity and can cause false timeouts or leaked test resources.

When a test reports that a `pi-integ-*` worktree path already exists, first check whether the same test already created that worktree and the deterministic provider dispatched the tool twice after asynchronous completion. Deterministic providers must make each requested tool call one-shot after its started result appears. Remove only verified test-owned residue after confirming that no workspace or process owns it.

```bash
npm run test:integration
```

Focused real TUI command: `node --experimental-strip-types --test test/integration/auto-routing.test.ts`.
Actual idle editor submission into an existing persisted session is routing evidence;
direct registered-handler units and RPC are not routing proxies. Separate real RPC
processes prove bypass. T10's isolated fake classifier/native setup must not resolve
host Claude/Kiro or contact live Jev. Pi 0.99.1 queued idle local cancel and public
`newSession` until awaited input resolved: these two scenarios are honest
blockers/skips, not passes. Escape reached timeout, not cancellation. Keep prior
implementation-time network incident evidence for parent disclosure; deterministic
setup requirements do not rewrite history as globally network-free.

Use `PI_TEST_MODEL="openai-codex/gpt-5.6-luna" PI_TEST_TIMEOUT=180000 npm run test:integration:live` only for optional provider-compatibility smoke coverage. The automatic suite skips in live mode. Do not use skipped Herdr tests as passing evidence. Report pass/fail/skip counts, limitations and restored test-owned resource inventory; clean only verified test-owned residue after process/workspace ownership checks.

Before committing:

- inspect `git status` and the final diff;
- confirm the package preview includes `CHANGELOG.md`, `skills/orchestrate/SKILL.md`, `skills/orchestrate/adversarial-review.md`, and `skills/orchestrate/adversarial-review-example.js`, while excluding `pi-extension/subagents/workflow-worker.js`, tests/evals/fixtures and generated captures, plans, journals, sessions, prototypes, generated evidence, local config, and `openspec/`;
- run `npm pack --dry-run` when package contents or documentation paths changed; durable configuration is `$PI_CODING_AGENT_DIR/herdr-agents/config.json`, never package-root `config.json` (move old files manually or re-run `/subagents-init`);
- confirm that no generated plans, journals, sessions, provider configuration, test scripts, or review artifacts are staged; and
- confirm that no accidental empty directory exists at the repository root:

```bash
test -z "$(find . -mindepth 1 -maxdepth 1 -type d -empty -print)"
```

## Release safety

Release verification must not enable auto routing, grant consent, approve tuples or
collect live prompts. Off/reload blocks later egress/launch, not running children;
unknown owned work requires explicit recovery, never automatic replay.

Do not bump `package.json` merely to land documentation or implementation work. A version change on `main` triggers the release workflow. Never commit npm credentials, generated review artifacts, session artifacts, or local `config.json`.
