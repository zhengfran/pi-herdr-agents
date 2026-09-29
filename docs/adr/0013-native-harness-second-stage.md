# ADR-0013: Second-stage native Claude Code and Kiro capabilities

- **Status:** Accepted
- **Date:** 2026-09-29
- **Scope:** `zhengfran/pi-herdr-agents` fork
- **Supersedes in part:** ADR-0012's rejection of persistent, fork/lineage,
  skill, nested-spawn, task-routing, fallback, resume, interrupt, follow-up,
  and interactive native capabilities
- **Extends:** ADR-0010 to native persistent specialists

## Decision

Native `cli: claude|kiro` roles gain the Pi-backed capabilities below. Every
capability has one explicit native meaning; combinations a native CLI cannot
represent faithfully are still rejected before Herdr creates resources.

**Shared turn driver.** One harness-neutral driver (`native-turns.ts`) now
serves both CLIs. Each orchestrator turn carries its own random tag and is
settled only by that tag's correlated hook receipt. Parent input is typed only
at a *verified idle point*: the latest tagged turn's correlated `Stop` or
`StopFailure`, or (interactive sessions only) a completed human-driven turn.
Typed text is flattened to one control-free line of at most 8 KiB. A typed
turn that is not acknowledged within its deadline is never retyped.

**Modes.** A role's `auto-exit: true` is *autonomous* (graceful exit after the
last tagged turn; human input fails closed). Without `auto-exit` it is
*interactive*: the parent never types an exit command, human turns are
tolerated, counted, and disclosed separately, and the result is delivered once
when the human quits. `persistent: true` is a *persistent specialist*.

**Follow-ups.** `subagent_send` to a running native non-persistent child queues
one correlated follow-up (limit 4). Each is typed once at the next verified
idle point. The final result lists every tagged turn's outcome. Autonomous runs
never deliver queued follow-ups after a failed turn (`not-delivered`).

**Persistent specialists.** ADR-0010 semantics apply unchanged: one task at a
time, `rejected-busy` with no queue while working, exactly-once delivery in the
ledger, and stop after the active task's terminal outcome. A dispatched task is
typed once at the verified idle point that makes the specialist idle. Stop
types the graceful exit only at a verified idle point. Specialists do not
advance to another model and do not revive.

**Interrupts.** Only a running native process whose owner token is verified
through `/proc`, with a correlated receipt showing the tagged turn active, can
be interrupted. The interrupt is recorded before Escape is sent, so the turn
settles as `interrupted` and never as a success, even if a `Stop` races the
key. Without a later verified idle point within 10 seconds, autonomous runs and
persistent specialists are ended by verified termination; interactive sessions
stay open for the human.

**Resume.** Fresh native runs write a v2 session marker with the complete
loadout and its SHA-256: tools, native tools, model, thinking, prompt mode,
identity hash (identity text in a 0600 file), mode, session mode, skills,
nested-spawn allowlist, Kiro agent name, lineage, and worktree binding.
`subagent_resume` accepts the marker and a required message and replays
exactly that loadout, including its recorded autonomous or interactive mode.
It never consults the current role; an `autoExit` that would change the mode
is rejected. The role identity text is read once at launch and must match its
recorded hash. Claude reopens `--resume <uuid>`; Kiro recreates the saved agent
name exclusively and uses `--resume-id`. Hooks fail closed if the native
session identity changes.

Durable lease files name the driving run's receipt and owner token. An
exclusive session lease, and for worktree runs a worktree lease beside the
ownership manifest, prevent two processes from driving one session or one
worktree across crashes and reloads. Leases are released only after confirmed
exit. A stale lease is reclaimed only when its run's exit is confirmed,
including every owned descendant. A worktree lease also records a reservation
by the launching parent (PID, kernel start time, random token). While that
parent is alive, or its identity cannot be proven, the lease stays held even
after the named run exits, until the parent releases it at final settlement. A
worktree-bound session resumes in an ordinary pane at the verified retained
checkout. That requires the same path, branch, and workspace, a manifest not
marked removed, no live or unresolved in-memory holder, and no held durable
worktree lease. Explicit cleanup also treats a held durable lease as a blocker.
v1 markers and persistent specialists are not resumable.

**Exit confirmation.** A wrapper exit receipt confirms exit only when a trusted
process scan shows that no owned descendant carrying the run's token survives.
It never confirms exit on its own. The same scan also finds every same-user
process related to the run: a descendant (by parent links) of an owned
process, or a member of the wrapper's process group, which a job-control shell
makes the wrapper lead and which orphaned descendants keep. A related process
whose environment is unreadable or lacks the token cannot be proven unowned and
keeps the run unresolved. So does an unreadable process whose relationships are
unknown. The wrapper's group is ignored only when its PID provably belongs to
another live process, because the kernel never reuses a PID that still names a
group. Linux scans `/proc`. macOS uses a same-user `ps -E` listing with parent
PIDs and process groups, trusted only when it shows this parent's own
environment. That listing proves presence or absence only and never
authorizes a signal. Without a trusted scan, or with a surviving descendant
after a short grace period, the run stays unresolved: no cleanup, lease
release, Git capture, resume, or fallback, and no signal on a normal exit. A
parent shutdown or cancelled call while a launch waits for its shell stops it
before its process is dispatched. A launch that fails after its script was
dispatched with an unconfirmed exit retains its pane, profile, marker, and
leases. It records the worktree as failed with unknown Git state and tracks the
run as unresolved until exit is confirmed.

**Fork and lineage.** `lineage-only` records the parent session in the loadout
and transfers no turns. `fork` transfers a bounded (32 KiB) text rendering of
the parent's compaction-aware active branch before the requesting user turn:
user and assistant text, summaries, and tool-call names only. Tool results,
arguments, reasoning, and images are excluded. It is embedded in the first
tagged turn inside an unguessable boundary marked as untrusted data, and
recorded as a 0600 artifact with its hash. No native history is fabricated.

**Skills.** Requested skills resolve through Pi's installed skill discovery and
are embedded in the first turn as Pi-format `<skill>` blocks. A skill with
supporting files is copied into a private, content-addressed, read-only
snapshot. The block references only that snapshot, and its hash is bound into
the loadout. Resume verifies the snapshot byte-for-byte, when requested and
again immediately before launch, and never rematerializes live assets. The
snapshot and its root must be real directories (not links) at the session's own
artifact location. Every entry below must be a real directory or a regular
file with a single link. Files are read without following links from a pinned
inode. After the walk, the root and every traversed directory (with its entry
names) and file (identity, metadata, and rehashed content) are rechecked, so a
nested swap or edit during verification fails closed.
Skills are rejected, never truncated, above 24 KiB each or 48 KiB total, or
with assets above 256 KiB (512 KiB total). A skill is also rejected when it
contains links or special files, declares tools the role lacks, has supporting
files without `read`, or ships scripts without `bash`.

**Nested delegation.** A native role may delegate only through an explicit
`spawn-agents` allowlist. The child receives one owned stdio MCP server with a
single `subagent` tool. Requests are HMAC-signed with a per-run secret. The
parent claims each request atomically and verifies run identity, nonce
freshness, age, and that the sender PID carries the run's owner token. It
then enforces policy: allowlisted role, explicit tools that are a subset of
the requester's, autonomous, not persistent, standalone ordinary pane, and a
leaf with spawning denied. Limits are four concurrent and 16 total per run.
Nested results return to the requester as one correlated, untrusted-data
follow-up turn. An autonomous requester does not exit while results are owed.
Delegation requires Linux `/proc` and is rejected for persistent specialists.

**Models.** Native roles take native CLI model IDs, ordered native lists, or
`task:<category>` resolved from `models.native.<cli>.tasks`, never Pi
provider/model refs (values found in Pi's registry are rejected). Fallback
advances only with positive evidence that the failed attempt did no task work.
Its exit must be confirmed. Its own correlated session-start receipt must
prove its hooks were active, with no prompt-submit receipt, human turn, or
hook error recorded. A failed outcome is never such evidence: a correlated
`StopFailure` follows an active turn that may have used tools, and an exit
before any receipt proves nothing. A completed result, even a negative one, is
never retried. A worktree attempt is reused for the next model only under the
same evidence and a verifiably pristine checkout. The durable worktree lease
stays reserved by the parent throughout, is handed to each attempt by an
atomic replace that checks the previous holder and the parent token, and is
released only after the final attempt's exit is confirmed. A competing cleanup
or resume between attempts therefore always sees it held. No attempt is
launched after the parent aborts, and a watcher failure is settled against
the attempt that failed, never the first one. An attempt that fails after
dispatch with an unconfirmed exit is the primary result (marker, session,
model, pane, and recovery); earlier attempts are history only. Attempts and
raw errors are reported in order with their markers.

**Persistent delivery.** Every settled specialist task is queued, unique by
task ID, before any delivery attempt, and appended to a private settled record
beside the marker. That includes the final outcome's settlement of a `Stop`
written just before the CLI exited. Delivery sends each task this parent
settled from correlated receipts to the parent exactly once. It never reads
the record, so a line another process writes there is never delivered. A
failed parent send (for example across `/reload`) is retried every tick, and
the specialist stays busy until delivery succeeds. After the process ends,
owed results are retried for a bounded time before the stop or exit notice.
Any still undelivered travel inside that notice, and a notice that fails to
send is retried until the same deadline. The durable ledger plus an in-memory
record prevent duplicates. An unreadable ledger proves no delivery, so owed
results stay pending, and it never aborts retries or the notice. A task whose
dispatch cannot be recorded is withdrawn before it is typed. A specialist's
first task is durable before its process exists: the ledger is checked
before any resource, `planned` is recorded just before dispatch, and
`dispatched` commits it afterwards. A launch that never started is recorded as
`abandoned`. A failed commit leaves the live specialist supervised with a
warning, never untracked. A plan left by a parent crash is resolved at the next
session start from the run's start receipt, after its cancel marker forbids a
late start.

## Why

The first stage proved that correlated hook receipts plus owner-token process
receipts make native completion verifiable. Each second-stage capability reuses
those receipts rather than terminal text, so the fail-closed properties carry
over. A shared driver replaces duplicated per-CLI turn logic now that follow-up,
interactive, persistent, interrupt, and resume turns exist for both CLIs.

## Consequences

Native runs gain Pi-level orchestration without a Pi transcript. The residual
risks are explicit: same-user processes can read owned 0600 files, so the
bridge secret and receipts resist confusion, staleness, and misdirected
siblings, not a malicious same-user process. Claude fires no hook for a user
interrupt, so an interrupted autonomous turn usually ends by verified
termination; resume then depends on the CLI having persisted the session. In
interactive sessions a follow-up typed at a verified idle point can merge with
a human's partially typed input; it is then `unacknowledged` and parent input
is suspended. macOS cannot prove process ownership for a signal, so interrupts
and nested delegation are rejected there and native processes are never
signalled. Exit is confirmed there only by the trusted `ps -E` listing; if `ps`
hides environments, every native run stays unresolved and its leases and
worktree stay held. A same-user process could forge an owner token in its
command line and so delay confirmation, but never cause one. A descendant that
leaves both the run's process tree and its process group and also hides or
scrubs its environment is not detected on either platform, and neither is a
descendant running as another user. Native model
fallback rarely applies: most model failures surface after the prompt was
submitted, where no-work cannot be proven. A prompt-submit hook killed before
writing any receipt could still look like "never started"; hooks are short,
locked, and synchronous, so this is accepted and disclosed.
