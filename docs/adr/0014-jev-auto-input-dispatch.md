# ADR-0014: Package-only Jev automatic input dispatch

- **Status:** Accepted architecture; live promotion remains uncalibrated and operator-gated
- **Date:** 2026-09-30
- **Scope:** `zhengfran/pi-herdr-agents` fork, public Pi 0.99.1 APIs
- **Extends:** ADR-0013's validated launch/projection authority; does not change ADR-0003 discovery or manual APIs

## Context

Automatic delegation needs both semantic task evidence and local execution
permission. A classifier catalog is not an allowlist. Pi 0.99.1 exposes an input
hook but no original-submission provenance, stable submission ID, cancellable
idle input transaction, or atomic custom-message-persistence/child-dispatch API.
An earlier extension can expand confidential content or remove images, commands
and opt-out syntax; a handled input prevents later checks from running.

We accept a deliberately smaller observable scope instead of requiring a host
patch, broadening to RPC, or inventing host guarantees. The canonical public
contract, disclosure, strict schema and operator workflow are in
[README: Automatic input routing](../../README.md#automatic-input-routing).

## Decision

### Public boundary and evidence

Use one parent-only public `input` coordinator. Only eligible idle top-level
`mode: "tui"`, `source: "interactive"`, undefined streaming behavior, current
no-images and safe nonblank current text can reach Jev. Require an existing
persisted session on disk, required public APIs and Herdr. Fresh/unpersisted
first prompts bypass. RPC/JSON/print/extension-source and steer/followUp bypass
in every mode; manual launches and task preferences never consult Jev.

The captured request is exactly this handler's text, not an attestation of
pre-transform editor input. Earlier transforms and installed-extension ordering
are operator trust concerns; the package cannot establish physical ingress,
original image/command/opt-out presence, universal secret screening, or that
other input checks ran. It adds no separate conversation or repository data for
classification, but earlier-expanded data can already be in the current text.

Use Pi's authenticated TypeSafe classifier interface, not another SDK/credential
client. Pin `typesafe` / `jev-1.13.0`, `jev-auto-questions-v1` and `jev-auto-v1`.
The built-in latest descriptor may provide an immutable transport descriptor
copy; it never authorizes a latest request. A bounded call-local observing fetch
checks the final outgoing pin/payload/approved endpoint and returned wire model,
full Choice/Score distributions, legends, Noul probabilities and normalized Pi
agreement. Missing observation/changed adapter contract fails closed. Two
batches maximum, zero retries, one bounded A+B/auth deadline.

### Local authority and launch

Only durable administrator consent plus an exact role/harness/model/effort
allowlist can authorize egress and launch. Shadow also egresses and needs consent.
No credential, endpoint override, executable config or launch-capability bag is
accepted. Prompt text and Jev are untrusted evidence, never permission.

Resolve normal precedence, then pin full role/provenance and installed-skill
fingerprints. Read-only candidate preparation uses the existing shared launch
preflight. Strict probability/confidence/margin/absolute-fit and semantic gates,
both complete Score distributions, upper-tail/low-confidence effort floors and
reviewed capability profiles yield one tuple or abstention. No model-name quality,
family, cost or access stereotypes. Effort buckets are policy, not portable budgets.
Revalidate config/session/cwd/branch/generation and the whole relevant feasible
candidate set before resources and dispatch; drift/revocation prevents later
egress/launch. No reclassification on drift or alternate route retry.

The exact tuple may authorize replacing a role pin and cross-harness projection;
manual launches still need an explicit destination model under ADR-0013. Pi and
native namespaces remain separate. Native prerequisites and strict tool/skill,
prompt-mode and effort projection remain authoritative; Pi auth does not prove
native account access. There is no additional permission grant.

Automatic children are named standalone autonomous nonpersistent ordinary-pane
leaves in the current shared checkout: no worktree, fork, nesting, fan-out,
persistent generation or added tool/skill. Review-purpose roles unconditionally
abstain in v1: no trusted author-family/pinned-evidence input is available. The
parent/manual review policy stays intact. Package child policy and the internal
side-session recursion marker prevent recursive routing; the marker is not an
authorization boundary. Jev-key unsetting is hygiene, not OS isolation.

### Ownership, durability and delivery

Reserve one synchronous in-flight decision slot before awaiting evidence. That
slot does not own a host submission. Safe unowned abstention/unavailability under
parent policy returns `continue`, with no extra turn; explicit hold consumes
without execution. Shadow returns `continue` immediately, evaluates only the
captured view observationally, and never owns, launches, suggests, or alters parent
context/runtime. Normal parent work does not cancel shadow evaluation.

Selected auto/pilot irreversibly owns before attempting `jev_auto_request`
persistence. Every owned outcome returns `handled`, even errors. Verify the
current branch's exact custom message through public observations and bounded
read-back of the existing session file before resources/dispatch. This verifies
normal disk persistence, not fsync or atomic persistence plus execution. Pilot
requires a bounded TUI confirmation; rejection/timeout holds. Status and bounded
non-context receipts report observations, not execution promises.

The dispatch latch becomes attempted before the process-send call. Known
no-dispatch, verified-persistence, valid-original-session failures alone can
attempt parent fallback once; void send return means `fallback-attempted`, not
confirmed parent execution. Cancel, stale state, persistence uncertainty and
possibly dispatched work hold. Unknown never auto-replays, adopts or retries and
blocks new automatic work on that active branch pending manual recovery.

Decision IDs correlate one package attempt, not a stable host submission or a
cross-process exactly-once execution. Identical submissions are distinct
attempts. A crash before persistence can lose pending input; after persistence it
can leave no-work or running-work without a started receipt, or uncertain
fallback delivery. Append, dispatch, delivery and input disposition are not one
host transaction. Inspect session/child evidence before an explicit retry.

Reuse existing watchers, completion/help/error and replacement-parent delivery;
no alternate watcher or successful-path parent wake-up. Automatic metadata uses
`auto` provenance, never pretends a user selected the runtime. Completion remains
a review handoff requiring parent synthesis, not acceptance. No caller polling.

### Cancellation and rollout

Use an owned controller for the deadline and **observed** local cancel or public
lifecycle/session events. Idle `ctx.signal` is not a cancellation facility.
Escape is not a reliable idle cancel. T10 observed Escape → `jev-timeout` and Pi
0.99.1 queued both `/subagents-routing cancel` and public `newSession` until the
awaited input resolved. Those two pre-dispatch scenarios are explicit
blockers/skips, not passing cancellation evidence. No private-hook substitution
or host modification is introduced. After dispatch, use existing child lifecycle
tools; the local cancel command does not terminate children.

Roll out off → offline fake → consented shadow → consented pilot → auto, with
measured workload evidence and administrator sign-off before promotion. T11 is
synthetic mechanical scaffolding, not achieved service/model quality or latency;
initial thresholds and profiles remain uncalibrated. Separate live capture needs
explicit informed consent and stays outside the package. Release/tests never
opt in. Roll back by setting off and reloading: later egress/launch is blocked,
not retroactive data transmission or already running children.

## Why

The smallest viable architecture reuses the proven exact launch/projection and
completion authorities while separating evidence from permission. Public-only
composition can ship as a package on the inspected host without a patched Pi
transaction. Conservative abstention and visible hold are preferable to silent
capability widening, duplicate execution after uncertainty, or fabricated
provenance. Explicit pins and full distributions make policy changes reviewable
and evaluable instead of relying on adapter-lossy means or model reputation.

## Alternatives considered

- **Patch Pi for original input/submission IDs/idle cancellation/transactions:**
  stronger possible semantics, but outside package scope; not a prerequisite or
  guarantee of this decision.
- **RPC/JSON/print routing or `hasUI` as admission:** rejected; RPC can have UI,
  and its queue/abort semantics are not this idle TUI ownership contract.
- **Switch the parent model or route manual APIs/task preferences:** rejected;
  changes explicit runtime intent and does not provide bounded child ownership.
- **Direct TypeSafe SDK, credentials/endpoints in config, or lossy adapter-only
  scores/latest alias:** rejected; duplicates authentication or loses required
  pin/distribution evidence.
- **Classify first, infer permissions from results/catalog/names:** rejected;
  evidence cannot approve roles, tools, projection, effort or native access.
- **Always continue on errors or replay unknown requests:** rejected after
  ownership; partial persistence/dispatch effects can duplicate execution.
- **Automatic worktrees, fork context, persistent/coordinator/reviewer fan-out:**
  deferred; they enlarge authority and need independent provenance/lifecycle
  contracts, not a classifier-selected launch bag.
- **Atomic/exactly-once claims from disk read-back and a decision ID:** rejected;
  no public transaction or stable submission identity establishes them.

## Consequences and threat model

Live modes add TypeSafe egress of current prompt and reviewed profiles, including
confidential upstream-expanded data. No-training is not zero retention/residency;
child and parent still use normal providers and local sessions. Same-user
extensions/processes are trusted composition, not sandboxed. Bash is not
universally read-only, the shared checkout is not a lock or sandbox, and child
Jev-key hygiene does not isolate ambient auth files or secrets.

The package bounds accidental egress, stale decisions and unauthorized tuples,
not malicious same-process extensions or same-user receipt/key readers. It cannot
promise original authenticity, universal screening, model-family quality from
names, portable effort, reliable Escape, stable submission identity, host atomicity,
cross-process exactly-once, RPC routing or machine-wide concurrency exclusion.
Low coverage, first-prompt bypass, manual crash recovery and cancellation blockers
are accepted costs. Operators must leave routing off if privacy, extension order,
shared-checkout or crash-window risk is unacceptable.

## Verification boundary

Offline config/candidate/transport/policy and public-handler tests exercise
mechanical behavior. Real TUI/Herdr integration uses actual idle editor submission,
existing session persistence, fake classifier and offline native executables;
separate real RPC tests prove bypass. Direct handler units are not TUI evidence.
Run one integration suite at a time, report the two honest Pi 0.99.1 skips and
restore test-owned resources. See [contributor guidance](../../AGENTS.md),
[release checks](../../RELEASING.md) and the
[source-checkout contributor integration workflow](https://github.com/zhengfran/pi-herdr-agents/blob/main/.pi/skills/run-integration-tests/SKILL.md)
(the skill is excluded from the installed package).

These deterministic/offline setup requirements are not a claim that all historical
implementation activity was network-free. Preserve incident evidence and disclose
implementation-time network/account effects separately in the parent handoff;
do not rewrite prior verification history.
