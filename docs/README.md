# Documentation map

Use this page to find the authoritative document for a task. Current shipped
behavior and accepted ADRs govern existing APIs. Historical plans and research
are evidence, not shipped contracts, when a later ADR supersedes them.

## Shipped contracts

- [`../README.md`](../README.md) — installation, public tools, configuration,
  lifecycle, and role authoring; [automatic input routing](../README.md#automatic-input-routing)
  is the canonical current-view TUI contract, schema and egress disclosure.
- [`../CONTEXT.md`](../CONTEXT.md) — orchestration glossary.
- [`../skills/orchestrate/SKILL.md`](../skills/orchestrate/SKILL.md) — public
  subagent review fan-out and parent synthesis procedure.
- [`../skills/orchestrate/adversarial-review.md`](../skills/orchestrate/adversarial-review.md)
  — adversarial topology, finding records, and incomplete-coverage policy.
- [`worktree-subagents.md`](worktree-subagents.md) — worktree operation,
  review, recovery, and cleanup.

The package launches asynchronous Pi/native children in Herdr and supports managed
worktrees for manually requested writing tasks. Off-by-default automatic routing
uses public Pi 0.99.1 APIs, pinned Jev evidence and durable exact-tuple approvals:
one standalone autonomous shared-checkout leaf, never a worktree. Only eligible
idle TUI/interactive current-view input with undefined streaming behavior, no
current images and a persisted session can route; RPC/JSON/print/extension-source
and steer/followUp bypass. Shadow also egresses and needs consent. Original input
provenance, reliable idle Escape, atomic persistence/dispatch and cross-process
exactly-once are not promised. See ADR-0014 for the two current-host cancellation
blockers and recovery limits. A separate default-off advisory `jev_router` tool (README: [Advisory route recommendation](../README.md#advisory-route-recommendation-jev_router)) recommends configured route names from an explicit bounded brief and never launches. Orchestrated review materializes pinned evidence,
launches fresh public reviewers, receives automatic completion delivery, and
has the parent synthesize outcomes. Role frontmatter tool allowlists are the
available enforcement boundary; `read,bash` is not read-only. Automated package
acceptance covers unit tests, lint, and `npm pack --dry-run`. Deterministic
Herdr integration is a manual release gate run from inside Herdr. The manual
supervision transport benchmark is `../test/bench/supervision-bench.mjs`; it
uses an isolated Herdr server and writes uncommitted raw samples to
`/tmp/issue29-bench/`.

## ADRs

| ADR | Status | Decision |
| --- | --- | --- |
| [`0001`](adr/0001-btw-ephemeral-side-questions.md) | Accepted | Add `/btw` as an ephemeral side-question child. |
| [`0002`](adr/0002-agent-workflow-skill-runtime-taxonomy.md) | Partially superseded by 0009 | Keep agent execution, skills, and Pi runtimes distinct. |
| [`0003`](adr/0003-installable-role-packs.md) | Accepted | Define installable role-pack discovery and collision rules. |
| [`0004`](adr/0004-require-active-user-approval-for-workflow-execution.md) | Superseded by 0009 | Historical exact-script approval decision. |
| [`0005`](adr/0005-parent-owns-workflow-script-authority.md) | Superseded by 0009 | Historical workflow-script authority decision. |
| [`0006`](adr/0006-limit-v1-execution-effects-to-isolated-worktrees.md) | Partially superseded by 0009 | Historical runner effect boundary; managed worktree rules remain. |
| [`0007`](adr/0007-require-fresh-review-for-workflow-scripts.md) | Superseded by 0009 | Historical workflow-review decision. |
| [`0008`](adr/0008-adopt-pi-only-subagent-execution.md) | Partially superseded by 0012 | Remove the legacy external CLI adapter; Pi remains the default execution path. |
| [`0009`](adr/0009-remove-workflow-subsystem.md) | Accepted | Remove the workflow subsystem; use public subagent fan-out and parent synthesis. |
| [`0010`](adr/0010-persistent-specialists-as-session-generations.md) | Accepted | Define persistent specialists as logical identities with policy-bound session generations. |
| [`0011`](adr/0011-explicit-worktree-cleanup.md) | Accepted | Authorize explicit worktree cleanup by cwd containment; retain branches and reject automatic reaping. |
| [`0012`](adr/0012-native-claude-kiro-harness.md) | Partially superseded by 0013 | Add first-stage native Claude Code and Kiro harnesses behind a small execution seam; partially supersedes 0008. |
| [`0013`](adr/0013-native-harness-second-stage.md) | Accepted | Add native persistent specialists, fork/lineage context, skills, nested delegation, native model routing and fallback, resume, interrupts, follow-ups, interactive sessions, and spawn-time harness selection by validated role projection; extends 0010. |
| [`0014`](adr/0014-jev-auto-input-dispatch.md) | Accepted architecture; live promotion uncalibrated | Package-only current-view TUI automatic dispatch: pinned Jev evidence, durable exact-tuple authority, verified request persistence, and explicit cancellation/crash/privacy limits. |

Development-only [offline evaluation](../test/evals/jev-routing-README.md) and
`npm run test:eval:jev-routing` validate synthetic mechanical fixtures, not
measured service/model quality. Tests/evals are excluded from the installed package;
use the source checkout for contributor commands. Real TUI integration is distinct
from handler units; run one suite at a time and never count skips as passes.

## Historical material

- [`orchestrated-review-workflow-plan.md`](orchestrated-review-workflow-plan.md)
  — superseded workflow design, retained as history.
- [`research/`](research/) — background evidence and alternatives, not shipped
  behavior.
