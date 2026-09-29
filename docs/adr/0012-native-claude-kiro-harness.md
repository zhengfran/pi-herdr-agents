# ADR-0012: Add first-stage native Claude Code and Kiro harnesses

- **Status:** Accepted; partially superseded by ADR-0013
- **Date:** 2026-09-29
- **Scope:** `zhengfran/pi-herdr-agents` fork
- **Supersedes in part:** ADR-0008's rejection of every `cli` role

## Decision

Roles may declare `cli: claude` or `cli: kiro` to run the native interactive
Claude Code TUI or Kiro CLI 2.24.x V2 in the child's Herdr surface. Any other
`cli` value and the removed `cli-model` field still fail closed before Herdr
creates resources.

The first stage supports ordinary fresh autonomous runs only, in an ordinary
pane or an explicitly requested managed worktree. Persistent specialists,
fork/lineage session modes, Pi skills, nested spawning, Pi child tools,
task-category or Pi fallback model semantics, native resume, native
interrupt, and running follow-up are rejected before resources exist.
ADR-0013 later defines native meanings for all of these except Pi child tools
(`caller_ping`, `subagent_done`), which remain rejected.

A small harness seam (`native-harness.ts`) owns only what varies: capability
validation and strict tool mapping, per-run exclusively created hook and state
files, native session identity, launch commands, process receipts, and owned
Kiro profile cleanup. Herdr pane/worktree provisioning, ownership manifests,
failure retention, the widget lifecycle, and bounded parent result delivery
stay common.

Success requires the tagged turn's native-session-correlated `Stop` hook
receipt plus a durable process-exit receipt after the parent's graceful exit
command. Herdr agent status and terminal text never establish success. Native
children record an explicit session marker/loadout artifact instead of a fake
Pi transcript.

Process ownership uses an unguessable per-run token in the wrapper's exec-time
environment, never a bare PID. Only token-verified processes are signalled;
unverifiable ownership signals nothing. Owned files are released and Git state
captured only after exit is confirmed; an unconfirmed exit is a failed,
evidence-retaining, worktree-holding outcome.

## Why

ADR-0008 rejected a single real second execution path because the old Claude
terminal adapter duplicated launch, completion, and cleanup behavior and
inferred completion weakly. The ported zhengfran/pi-interactive-subagents
adapters (MIT) provide per-run correlated hook receipts and durable process
receipts, which make native completion as verifiable as Pi's sidecar, and the
seam keeps Herdr orchestration shared rather than duplicated.

## Consequences

Native roles bypass Pi model routing and require the native CLI and `python3`
on `PATH`. Approval prompts are bypassed only for the strictly mapped tool
set, with no MCP servers. A first-run Claude workspace-trust dialog is never
answered and fails the run after its acknowledgement deadline. Native resume,
follow-up, interrupts, and persistent specialists require a later decision.
