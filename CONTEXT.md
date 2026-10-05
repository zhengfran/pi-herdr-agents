# Orchestration glossary

## Language

**Pi subagent runtime**:
The Pi execution path for fresh and resumed Pi-backed children. `launchPiSubagent()`
owns the complete Pi and Herdr launch sequence (not an atomic host transaction);
completion uses Pi sidecar
evidence first and the terminal exit marker as fallback.
_Avoid_: Runtime dispatch, adapter registry, split launch ownership

**Child wake-up signal**:
An internal indication that prompts fresh inspection of an owned child. It does
not itself establish completion, failure, or a help request.
_Avoid_: Completion result, user alert

**Child result delivery**:
The parent-facing handoff of a child run's observed outcome and available
evidence. Receiving it does not establish that the work is correct or accepted.
_Avoid_: Wake-up signal, acceptance

**No-progress advisory**:
An internal warning that an active child shows no durable progress in its session
JSONL or activity snapshot. It is advisory only and never changes the child's
outcome or triggers recovery.
_Avoid_: Hang verdict, automatic recovery, stall replacement

**Native harness role**:
A role definition with `cli: claude` or `cli: kiro` whose child runs the native
CLI in its Herdr pane or managed worktree instead of Pi. It runs in one native
mode: autonomous (`auto-exit: true`), interactive, or persistent. Success
requires correlated native turn evidence plus process exit, and the result is
delivered through the normal child result path.
_Avoid_: Screen-scraped completion, fake Pi transcript, Pi model routing

**Spawn-time harness selection**:
The per-spawn choice of runtime harness (`pi`, `claude`, or `kiro`) for a
named role. The effective harness is the explicit `harness` request, else the
role's `cli`, else Pi. It is resolved once, before any Herdr resource, and
recorded as the spawn's selection with its source and role provenance. It
requires a named role, never changes role discovery or precedence, and is never
re-resolved by fallback attempts, persistent tasks, or resume.
_Avoid_: Bare harness override, role rewrite, resume-time re-selection

**Validated role projection**:
Running a role on a harness other than the one it declares by interpreting its
capabilities under the destination harness's rules, and rejecting before any
resource whatever that harness cannot represent faithfully (tools, thinking,
skills, prompt mode, delegation). A role's pinned model belongs to its own
harness and is replaced only by an explicit destination model on manual launches,
or a verified administrator-approved exact automatic tuple. It is not a
transparent conversion: nothing is dropped, mapped, widened, or retried on
another harness, and Pi and native model namespaces never mix.
_Avoid_: Transparent conversion, tool translation, cross-harness fallback,
reusing a pinned model

**Automatic input routing**:
An off-by-default parent-only public Pi 0.99.1 input coordinator using pinned Jev
evidence to select one administrator-approved exact role/harness/model/effort.
Only eligible idle top-level TUI/interactive current-view input with undefined
streaming behavior, no current images and an existing persisted session can
route. RPC/JSON/print/extension-source and steer/followUp bypass in every mode;
fresh unpersisted first prompts and child/side sessions bypass. Automatic children
are standalone autonomous shared-checkout ordinary-pane leaves, never worktrees,
forks, persistent specialists or nested coordinators. Review-purpose roles abstain.
See [the public contract](README.md#automatic-input-routing) and
[ADR-0014](docs/adr/0014-jev-auto-input-dispatch.md).
_Avoid_: RPC routing, parent model switch, task-preference authorization

**Handler-visible captured request**:
Exactly the current text seen by the routing handler. Earlier extensions may have
expanded confidential file/history data or removed images, commands and opt-out
syntax. Later handlers do not run after `handled`. There is no original-input
provenance, ordering or physical-ingress authenticity guarantee.
_Avoid_: Original editor submission, universal secret screening

**Automatic tuple approval**:
Durable administrator authorization binding exact role/provenance fingerprint,
harness, model namespace/ID and supported effort, with reviewed compact capability
profiles. Jev probabilities are evidence only. Changed role/skill/config/runtime
snapshots invalidate selection; role changes require deliberate reapproval.
_Avoid_: Model catalog as permission, name-derived quality, portable effort

**Automatic decision slot**:
One local in-flight attempt reserved synchronously before awaits, distinct from
request ownership. Shadow is observational and immediately continues parent
input; it still egresses and requires consent. Safe unowned parent-policy
abstention/unavailability can continue without a replacement turn.
_Avoid_: Machine-wide lock, duplicate-submission detection

**Automatic request ownership**:
The irreversible latch set before attempting `jev_auto_request` persistence or
resource-bearing launch. Owned paths always return `handled`. Public current-branch
observations and bounded disk read-back must verify the captured custom message
before resources/dispatch. Known no-dispatch failures alone can attempt parent
fallback; cancel, stale or uncertain work holds.
_Avoid_: fsync guarantee, atomic host transaction, error fall-through

**Advisory route recommendation**:
A default-off parent-only `jev_router({task, context?})` result: uncalibrated
pinned-Jev evidence over an explicit bounded brief and configured route names and
descriptions only. It never launches or selects a model/effort, shares only the
bounded transport with automatic routing, and needs separate `jevRouter` consent.
The parent may override it and then uses the unchanged `subagent({route})`.
_Avoid_: Auto route, route permission, model selection, review independence

**Package decision ID**:
Correlation for one local routing attempt, not a host submission identity.
Repeated identical submissions are distinct decisions. A live dispatch latch
limits repeats within that decision; pre-persistence crashes can lose input and
post-dispatch crashes can leave unknown work. Unknown never auto-replays.
_Avoid_: Cross-process exactly-once, durable replay key, prompt-hash deduplication

**Observable routing cancellation**:
Package deadline or a local cancel/lifecycle/session event when its handler can
actually run. Idle Escape is not a reliable cancel API. Pi 0.99.1 queued local
cancel and public newSession until awaited input resolved; those pre-dispatch
integration cases remain blockers/skips. Off/reload does not stop dispatched children.
_Avoid_: Escape cancellation guarantee, skipped-as-pass, retroactive revocation

**Tagged turn**:
One orchestrator-submitted native prompt carrying its own
`[pi-subagent-turn:<token>]` tag. Only that token's correlated `Stop` or
`StopFailure` hook receipt settles it as completed or failed. An interrupt,
supersession, missing acknowledgement, or undelivered follow-up settles it
without success.
_Avoid_: Latest assistant text, Herdr idle status, human turn

**Native startup block**:
A diagnosed human-only gate before Claude's first initial or resume turn is
acknowledged. Workspace trust requires a present pane, Herdr `blocked` status,
and a strict bounded visible-screen match containing the trust heading, full
read/edit-or-write/execute warning, and affirmative and negative choices. Screen text
is ephemeral diagnostic failure evidence only: it is never persisted and never
establishes completion or no-work. The parent never answers the gate; it uses
verified owned-process termination and retains the pane for manual close.
_Avoid_: Screen-scraped completion, automatic trust answer, fallback-safe no-work

**Verified idle point**:
The moment a native TUI provably accepts input: the latest tagged turn's
correlated `Stop`/`StopFailure` receipt, or in interactive sessions a completed
human-driven turn. The parent types follow-ups, tasks, nested results, and exit
commands only here, and never while a typed turn awaits acknowledgement.
_Avoid_: Typing into a busy TUI, answering a dialog, retyping lost input

**Human-driven turn**:
An untagged native turn started by a person typing into the pane. In
interactive sessions it is counted and disclosed separately and never presented
as the orchestrator's result; in autonomous and persistent runs it fails closed.
_Avoid_: Orchestrator turn, task result

**Native follow-up**:
A `subagent_send` message queued for a running non-persistent native child
(limit 4) and typed once as a new tagged turn at the next verified idle point.
Its outcome is reported in the final result.
_Avoid_: Persistent task, steer into a busy session

**Native interrupt**:
An interrupt recorded against the active tagged turn of a verified owned live
native run before Escape is sent. The turn settles as interrupted, never as a
success. Without a later verified idle point, autonomous and persistent runs
are ended by verified termination; interactive sessions stay open.
_Avoid_: Kill, successful completion, unverified signal

**Unconfirmed native exit**:
A native run whose owned processes cannot be proven gone. Either no trusted
owned-process scan (Linux `/proc`, or a macOS `ps -E` listing that shows the
parent's own environment) shows none remain, or a token-carrying descendant
survives, or a same-user process related to the run (a descendant of an owned
process, or a member of the wrapper's process group) cannot be proven unowned
because its environment is unreadable or lacks the token. A wrapper exit
receipt alone never confirms exit. This includes a
launch that failed after its script was dispatched. It is reported as failed
with a warning, and its pane, Kiro profile, run files, native session lease,
and worktree lease are retained until exit is confirmed.
_Avoid_: Assumed exit, cleanup on timeout, PID-based ownership, wrapper-only exit

**Native session marker**:
The parent-owned v2 `native-sessions/<id>.json` artifact recording a native
child's harness, native session identity, cwd, and complete loadout with its
SHA-256. It anchors result references and native resume; it is not a Pi
transcript.
_Avoid_: Transcript, current role definition

**Native loadout**:
Everything that bounds a native session: tools and their native mapping,
model, thinking, prompt mode, identity hash, mode, session mode, skills with
their snapshot hashes, nested-spawn allowlist, selected personal Kiro MCP
server names and definition digests, Kiro agent name, lineage, and worktree
binding. Resume replays it exactly, including its mode, and never widens or
narrows it.
_Avoid_: Role lookup at resume, per-call override, mode change on resume

**Native session lease**:
The exclusive, durable `<marker>.lease` file (and for worktree runs the
`<manifest>.native-lease` worktree lease) naming the one run driving a native
session or worktree by receipt and owner token. It survives parent crashes and
is released only after that run's exit, descendants included, is confirmed. A
worktree lease also carries the launching parent's reservation (PID, start
time, token), is handed between fallback attempts by an atomic replace, and
stays held while that parent lives until it releases the lease at final
settlement. A stale lease is reclaimed only with
confirmed exit evidence.
_Avoid_: PID lock, time-based expiry, in-memory-only holder

**Inherited context artifact**:
The bounded, untrusted text rendering of the parent's active branch that a
native `fork` child receives in its first tagged turn and that is recorded as a
0600 artifact. `lineage-only` transfers no turns.
_Avoid_: Fabricated native history, full transcript copy

**Materialized skill**:
An installed Pi skill embedded in a native child's first turn as a bounded
`<skill>` block, only when its declared tools, supporting files, and scripts
are usable with the role's tools. Supporting files are copied into a private,
content-addressed, read-only snapshot bound into the loadout; the block never
points at the live installation. Resume verifies the snapshot at the session's
own artifact location, rejects linked or non-directory roots and any nested
symbolic link, hard link, or special file, reads pinned files without
following links, rechecks every traversed entry's identity and content after
the walk, and verifies again immediately before launch. Oversized skills are
rejected, never truncated.
_Avoid_: Partial skill, live asset reference, Pi-only runtime assumption

**Selected personal Kiro MCP grant**:
A Kiro-only role capability naming exact servers from the user's global Kiro
MCP configuration. The owned profile keeps bulk MCP import disabled and exposes
only selected `@server` tools through secret-free proxy definitions. Executable
fields and environment key names are digest-bound into the native loadout; live
values remain in the personal configuration, may change endpoints or
application behavior without digest drift, and are read only by the proxy at
server start. The proxy forwards a minimal launcher environment, rejects generic
loader/search/run-internal keys, and never gives the server the native owner
token. Every selected server tool is non-interactive under
`--trust-all-tools`; automatic and nested launches reject this capability.
_Avoid_: `includeMcpJson: true`, copying credentials into the checkout, ambient MCP access

**Nested-spawn bridge**:
The owned stdio MCP server and signed request directory through which a native
child with a `spawn-agents` allowlist asks the parent to launch leaf children
within its own tool ceiling. Results return as untrusted-data follow-up turns.
_Avoid_: Shelling out to Pi, unrestricted delegation

**Required-route policy**:
The opt-in `routePolicy.requiredForAgents` mapping from exact agent names to the
configured routes that alone may launch them. A protected agent's direct launch
is rejected with `route-required` before any Herdr resource exists; surviving
native children are held to the reloaded policy. Automatic input routing and
resume are outside it.
_Avoid_: Role permission, model allowlist

**Native model candidates**:
Ordered native CLI model IDs for one native launch, from an exact ID, a list,
or `models.native.<cli>.tasks`. They are never Pi provider/model refs. Fallback
advances only with positive evidence that the failed attempt never started
its first turn: a correlated session receipt with no prompt-submit receipt or
hook error, and a confirmed exit.
_Avoid_: Pi task shortlist, retrying a completed result, retry after StopFailure

**Unsupported external CLI role**:
A role definition whose `cli` is neither `claude` nor `kiro`, or that uses the
removed `cli-model` field. Discovery reports a diagnostic, and launch fails
before Herdr creates a pane or worktree.
_Avoid_: Silent Pi reinterpretation

**Public review fan-out**:
A parent procedure that materializes pinned evidence, launches fresh public
reviewer subagents, receives automatic result delivery, and synthesizes every
outcome. Reviewers use ordinary panes and do not poll for completion.
_Avoid_: Hidden child runner, approval gate, parentless aggregation

**Pinned review evidence**:
The parent-captured repository identity, base and head SHAs, task/spec text,
provenance, changed-file inventory, complete diff, and deleted or base-only
content supplied to reviewers. Dirty state is included only when explicitly
captured and fingerprinted.
_Avoid_: Moving-checkout inference, head-only deleted-content review

**Role allowlist**:
The `tools:` inline comma-separated role-frontmatter scalar passed to Pi for a
public child. It is the enforced capability boundary available to a reviewer.
`read,bash` is not read-only because Bash can mutate files.
_Avoid_: Shell-as-read-only claim, implicit capability grant

**Finding record**:
A bounded review record with a stable ID, claimed P0–P3 severity, nullable
confirmed severity, separate provenance, evidence status (`reproduced`,
`trace-backed`, or `unverified`), preconditions, reproduction or trace, expected
and actual behavior, impact, and minimal fix. An unverified potential P0/P1 is
a candidate for verification, not a certified finding.
_Avoid_: Confidence gate, provenance-as-severity, vote count

**Incomplete review**:
A review outcome for drift, failure, missing or truncated evidence, malformed
output, coverage gaps, or unresolved serious candidates. A child-reported
`INCOMPLETE` propagates to the parent result.
_Avoid_: Hidden missing coverage, certified uncertainty

**Persistent specialist**:
A logical subagent that retains one policy-bound Pi or native session between
sequential tasks until it is stopped or crashes.
_Avoid_: Immortal process, reusable pane

**Session generation**:
One concrete Pi or native session serving a persistent specialist's logical
identity.
_Avoid_: Logical specialist, revived session

**Task outcome**:
The recorded terminal result for one persistent-specialist task, including
`delivered`, `rejected-busy`, or a stop-pending task's eventual terminal state.
A native specialist's first task is `planned` before its process is
dispatched, then `dispatched` once it is, or `abandoned` when its launch
provably never started; a plan alone is never an active task.
_Avoid_: Assumed completion, replay candidate

**Delivery ledger**:
The append-only evidence record of persistent task dispatch and terminal
outcomes for one session generation.
_Avoid_: Work queue, mutable task list

**Agents tab**:
An extension-owned Herdr tab grouping delegated child panes in an existing
checkout workspace. Ownership comes from returned IDs, not its display label.
The pane cap includes every live pane; overflow creates another tab, not a
workspace. Separate parent processes own separate groups.
_Avoid_: Agent workspace, label-based ownership, automatic rearrangement

**Retained checkout shell**:
The interactive shell in a managed worktree's root pane, preserved after the
child Pi process exits. Temporary review panes can close without deleting this
surface or its checkout.
_Avoid_: Completed agent process, disposable pane, automatic worktree cleanup

**Worktree lease**:
The lifetime-exclusive binding between a live child and one managed worktree:
a persistent specialist generation, a native run including its fallback
attempts, or a native resume bound to that retained checkout.
_Avoid_: Rebindable checkout, shared worktree ownership

**Worktree inventory**:
An inspect-only view joining managed checkout discovery, Git registration/state,
Herdr workspace association, and reachable owned manifests, including orphans.
_Avoid_: Session-only resource list, cleanup action

**Cwd containment**:
Cleanup authorization requiring the canonical source repository root to equal or
be a descendant of the invoking session's canonical cwd.
_Avoid_: Managed-path containment, manifest ownership authorization

**Cleanup eligibility**:
Fresh evidence of cwd containment, registered checkout identity, a named branch,
no detected process holder, known live child, or persistent lease, and clean Git
state. Only Herdr-confirmed idle retained shells are exempt from process checks,
never runtimes at the same PID. Ignored files and individual process-visibility
gaps are disclosed, not blockers. Other unknown evidence blocks removal.
_Avoid_: Guessed idle, presumed clean

**Process-inspection warning**:
Non-blocking disclosure of incomplete same-user process visibility, separate
from cleanup blockers and requiring no override flag. Scanning continues after
unreadable details; detected holders still block. Other-user processes are not
inspected, and a protected process could hold the checkout undetected. Failed
global enumeration and unsupported platforms remain blockers.
_Avoid_: Proven unrelated, machine-wide inactivity, bypass permission

**Explicit worktree removal**:
A parent-requested removal of one named managed checkout and its open workspace,
with absence verification and retained branch history. Never automatic reaping.
_Avoid_: Branch deletion, completion cleanup

**Dirty-state preservation**:
Explicit opt-in staging and WIP commitment of a worktree's uncommitted and
untracked files on its retained branch before rechecking removal eligibility.
Ignored files are not captured. Commit failure restores the original index.
_Avoid_: Implicit commit, stash, discard

**Task-category model preference**:
An ordered authenticated model shortlist in `models.tasks` for `coding`,
`review`, `recon`, `qa`, `architecture`, or `docs`. Recon maps to scouts,
architecture to planning and diagnosis, coding to workers, review to reviewers,
QA to software and test runners, and docs to documentation workers. Categories
describe work, not complexity. `/subagents-init [preferences]` drafts them from
the active extension-loaded registry's synchronous snapshot and existing saved
choices, with source-based research when available. A dynamic provider awaiting
its initial catalog refresh might be absent. `task:<category>` is a subagent
model selector, not a command or parent model change. These preferences and
`/subagents-init` do not enable or authorize automatic routing; the writer preserves
unrelated `autoRouting` config without consent grants. Ordered authenticated
candidate plans resolve before launch; ordinary nonpersistent runs can retry
after launch failure or a running child's provider/agent error, not a completed
negative task result. Persistent specialists do not advance after a running-child
error. Worktrees select the first authenticated candidate only, without fallback
retries. Native roles use native model candidates instead. Cross-family independent review requires a reviewer from a different
model family than the author. For ordinary review, prefer a different
authenticated model family. When no other authenticated model family is
available, ordinary review may use a same-family reviewer in a fresh standalone
session. Disclose that this review is context-isolated, not cross-family
independent. Cross-family verification, `/skill:orchestrate`, and
`adversarial-reviewer` must not use this fallback. Family is the independence
boundary; project policy may separately require a
different provider.
_Avoid_: Generic tier, reviewer-family enforcement, per-step routing

**Loop template**:
A future reusable orchestration definition beside `models`, describing stages,
task categories, and a termination/report contract. Loop templates are not
implemented by task-model routing.
_Avoid_: Current executable workflow
