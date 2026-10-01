# Pi Herdr Agents

> [!NOTE]
> This repository is a fork of [giuseppecrj/pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents), based on upstream commit [`ada6018`](https://github.com/giuseppecrj/pi-herdr-agents/commit/ada60185600383a207bb2a24e43d9b66b9ed8288). This fork adds native Claude Code and Kiro harnesses while preserving the upstream Herdr and managed-worktree architecture.

![Pi Herdr Agents: parallel Pi agents running asynchronously in dedicated Herdr panes and managed worktrees.](https://raw.githubusercontent.com/zhengfran/pi-herdr-agents/main/docs/assets/pi-herdr-agents-gallery.png)

Asynchronous subagents for [Pi](https://github.com/earendil-works/pi), running exclusively in [Herdr](https://herdr.dev).

Delegate investigation, implementation, and review without blocking the parent session. Each child runs as a real Pi or supported native CLI process in its own Herdr surface; results return automatically when the child finishes.

## Features

- **Non-blocking delegation** — `subagent` acknowledges launch immediately while the parent keeps working.
- **Parallel execution** — run independent scouts, workers, and reviewers at the same time.
- **Live supervision** — track process and turn state in Pi's subagent widget; interrupt one child turn without destroying its session.
- **Managed worktrees** — isolate writing agents in retained Herdr workspaces with explicit Git ownership and recovery details.
- **Conversation handoff** — continue the active Pi conversation in a new worktree with `/worktree` while preserving the parent session.
- **Orchestrated reviews** — fan out fresh public reviewers and synthesize their evidence in the parent.
- **Reusable roles** — use bundled agents, project or global definitions, and installable role packs.
- **Persistent specialists** — retain one policy-bound Pi or native session for sequential, turn-based tasks.
- **Native Claude Code and Kiro roles** — run `cli: claude|kiro` roles with correlated turn receipts, exact-loadout resume, queued follow-ups, verified interrupts, interactive sessions, fork context, skills, native model fallback, and allowlisted nested delegation.
- **Spawn-time harness selection** — run a named role on `pi`, `claude`, or `kiro` for one spawn with `harness` or `/subagent <role> --harness`, as a strictly validated projection of the role.
- **Opt-in automatic TUI delegation** — pinned Jev evidence can select one administrator-authorized exact role/harness/model/effort tuple. Off by default; shadow also sends data. See [Automatic input routing](#automatic-input-routing) before opting in.

## Requirements

- [Pi](https://github.com/earendil-works/pi) with package support
- [Herdr](https://herdr.dev) and its CLI
- `HERDR_ENV=1` — start Pi from inside Herdr

Other terminal multiplexers are not supported. Session startup skips worktree inventory to avoid blocking Pi initialization; use `/worktree list` or `worktree_list` to inspect managed worktrees. Outside Herdr, explicit inventory tools still report unavailable inspection as unknown. Worktrees isolate Git checkouts, not processes or permissions; child agents and installed Pi packages run with your user account's access.

## Install

This fork is not published under the upstream `pi-herdr-agents` npm name. Install it from Git to get the native Claude Code and Kiro support:

```bash
pi install git:github.com/zhengfran/pi-herdr-agents
```

Install project-locally or try it for one run:

```bash
pi install -l git:github.com/zhengfran/pi-herdr-agents
pi -e git:github.com/zhengfran/pi-herdr-agents
```

Then start Pi inside Herdr:

```bash
herdr
pi
```

Restart or `/reload` Pi after installation. Review package source before installing any Pi package.

## Quick start

Ask Pi to delegate naturally:

```text
Use two scouts in parallel to map the authentication flow, then summarize their findings.
```

Or launch a named role directly, optionally on another harness:

```text
/subagent scout Analyze the authentication module and report relevant files and risks
/subagent scout --harness claude --model sonnet Analyze the authentication module
```

For an isolated writing task:

```text
/worktree auth-fix Implement the approved authentication fix and run the focused tests
```

Pi can also call the tool directly:

```typescript
subagent({ name: "Auth scout", agent: "scout", model: "<provider>/<fast-tier-id>", thinking: "low", task: "Map the authentication flow" });
subagent({ name: "DB scout", agent: "scout", model: "<provider>/<fast-tier-id>", thinking: "low", task: "Map the session schema" });
// Both return immediately; each result comes back independently.
```

Use ordinary panes for read-only agents. A single or sequential writer can work in the parent checkout; give each parallel independent writing agent a unique managed worktree. The parent acts as coordinator: decompose work, give each child one bounded outcome with its goal, allowed files, verification, and commit instruction, and keep dependent writes sequential. Children are leaves by default; the parent owns integration and final verification. See [Worktree subagents](docs/worktree-subagents.md).

## How it works

![Pi Herdr Agents lifecycle: spawn a child, run it in Herdr, supervise live state, and deliver one bounded result to the parent.](https://raw.githubusercontent.com/zhengfran/pi-herdr-agents/main/docs/assets/async-subagent-lifecycle.png)

A `subagent` call selects the target checkout, reuses its Herdr workspace, and gives the child a pane in an extension-owned `Agents` tab. Four panes fit in each tab by default; overflow opens another tab in the same workspace. A worktree is created only when explicitly requested for checkout isolation. The call launches a child Pi or native session and returns `started`. The parent watcher combines Herdr process state with child activity details and projects the result into a live widget:

```text
╭─ Subagents ──────────────────── 1 active · 1 open ─╮
│ 00:23  Scout: Auth (scout)        active · read 7m │
│ 00:45  Reviewer (reviewer)              waiting 2m │
╰────────────────────────────────────────────────────╯
```

When the child completes, the parent receives one bounded `subagent_result` message and starts a new turn with that result in context. Disposable ordinary panes close after result delivery, or for an autonomous native child whose process exit is still unconfirmed, after a later re-check confirms that exit; Herdr removes a tab when its last pane closes. Persistent specialists keep their pane between tasks, and managed worktree roots return to retained interactive shells. Callers never need to poll, tail session files, or wait in a shell loop.

## Troubleshooting completion delivery

If a child finishes but the parent returns an empty or unrelated response, first verify that the result reached the parent session:

```bash
jq -c 'select(.type == "custom_message" and .customType == "subagent_result")' "$PI_SESSION_FILE" | tail -1
```

If the entry exists, spawning and result extraction worked; investigate parent wake-up and model-facing delivery rather than the child process. Completion wake-ups must contain the bounded result directly—do not send a separate message that merely tells the parent to look at an adjacent custom message.

Git package refs are pinned. To move an installed development copy back to the current `main`, install that ref explicitly and reload the active Pi session:

```bash
pi install git:github.com/zhengfran/pi-herdr-agents@main
# Then run /reload inside Pi.
```

Smoke-test delivery with an autonomous subagent instructed to return one exact marker. Success means the marker itself—not only a generic wake-up notice—automatically appears in the parent turn.

Subagent tabs, panes, and worktree workspaces are created without stealing keyboard focus. Launch commands target child panes by explicit ID, so focus and command delivery are independent. If a fresh or resumed launch fails, the extension closes the ordinary pane that it created and preserves the original launch error. It does not close a caller-supplied surface, and managed worktree workspaces remain retained on failure. Note: the `interactive` option controls parent status notifications, not terminal focus.

## What's Included

### Extensions

**Subagents** — 9 parent-session tools + 8 commands, plus 2 child-only tools:

| Tool                 | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `subagent`           | Spawn a sub-agent in a dedicated herdr pane (async — returns immediately)             |
| `subagent_interrupt` | Interrupt a running subagent's current turn (native: verified owned live turns only)       |
| `subagent_send`      | Deliver a follow-up task to an idle persistent specialist, or queue a follow-up for a running native child |
| `subagent_stop`      | Gracefully stop a persistent specialist after its active task settles                      |
| `subagents_list`     | List available agent definitions                                                            |
| `worktree_list` | Parent-only inspect-only inventory of managed worktrees and cleanup blockers |
| `worktree_remove` | Parent-only explicit removal by `target` path, branch, or workspace ID; optional `preserve: true` commits dirty state first |
| `subagent_resume`    | Resume a previous Pi session, or a native session marker with its exact loadout, in a new ordinary pane (async) |
| `subagents_write_task_models` | Parent-only internal tool that validates and atomically writes `models.tasks` preferences |

| Pi child-only tool | Description |
| ---------------- | ------------------------------------------------------------------------- |
| `caller_ping` | Ask the parent for help; ordinary children exit, persistent specialists stay alive |
| `subagent_done` | Mark an interactive child complete and exit; autonomous agents auto-exit |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/plan`                    | Start a full planning workflow       |
| `/iterate`                 | Fork into a subagent for quick fixes |
| `/btw <question>`          | Open an ephemeral side-question session in a background tab |
| `/btw-close`               | Close the current BTW session        |
| `/worktree <name> [task]`  | Continue this session in a new managed worktree (`/worktree list` lists them) |
| `/subagent <agent> [--harness pi\|claude\|kiro] [--model <value>] [--thinking <level>] [--] [task]` | Spawn a named agent directly, optionally on another harness (`/subagent list` lists available agents); see [Spawn-time harness selection](#spawn-time-harness-selection) |
| `/subagents-init [preferences]` | Draft task-category model preferences from the live authenticated registry, with optional ranking preferences; does not enable or authorize automatic routing |
| `/subagents-routing status\|cancel` | Local automatic-routing diagnostics or observable preflight cancellation; cannot enable routing, approve tuples, or terminate a running child |

### Taxonomy and discovery

This package distinguishes directly runnable **agent roles**, Pi-native
**skills**, and authenticated Pi **runtimes**. A multi-stage user outcome may
be a command or skill that composes roles; it is not itself an agent role.

The current orchestration inventory is:

| Surface | Entry point | Behavior |
| --- | --- | --- |
| Planning | `/plan` | Scout, interactive planner, workers, and reviewer; writes plan artifacts. |
| Iteration | `/iterate` | Opens one interactive full-context Pi fork. |
| Side question | `/btw`, `/btw-close` | Opens one replaceable interactive Pi side session. |
| Worktree handoff | `/worktree <name> [task]`, `/worktree list` | Forks the active conversation into a managed worktree. |
| Orchestrated review | `/skill:orchestrate` | Parent materializes evidence, fans out public reviewers, and synthesizes results. |
| Adversarial review | `/skill:orchestrate`, `adversarial-reviewer` | Risk-based public discovery, cross-family verification, and parent synthesis. |
| Automatic input routing | Eligible idle top-level TUI input; durable `autoRouting` opt-in | One authorized standalone autonomous leaf in the shared checkout; no worktree or review-purpose launch in v1. |

See [ADR-0002](docs/adr/0002-agent-workflow-skill-runtime-taxonomy.md) and
[ADR-0009](docs/adr/0009-remove-workflow-subsystem.md).

### Bundled visible definitions

| Definition | Classification | Default runtime | Responsibility |
| ---------- | -------------- | --------------- | -------------- |
| **planner** | Coordinator agent role | Config, then parent | Clarifies requirements, explores approaches, and writes plans with ordered tasks. |
| **scout** | Leaf agent role | Config, then parent | Maps relevant code, conventions, and verification paths. |
| **worker** | Leaf agent role | Config, then parent | Implements bounded tasks and verifies the result. |
| **reviewer** | Leaf agent role | Config, then parent | Reviews changes for correctness, security, and maintainability. |
| **visual-tester** | Leaf agent role | Config, then parent | Performs visual QA through the `chrome-cdp` skill. |
| **researcher** | Leaf agent role | Config, then parent | Searches the web and returns a sourced brief through `pi-web-access` tools. |
| **poteto** | Coordinator agent role | Config, then parent | Autonomously investigates, edits minimally, delegates independent work, and verifies. |
| **adversarial-reviewer** | Coordinator role | Exact eligible authenticated Pi models selected by risk and project policy | Runs two routine or three high-risk discovery reviewers, candidate-dependent cross-family verification, and parent synthesis through public asynchronous children. |

Subagents execute through Pi by default, and Claude models remain available
through normal Pi provider/model routing. A role may instead declare
`cli: claude` or `cli: kiro` to run the native Claude Code or Kiro CLI in its
Herdr pane; see [Native Claude Code and Kiro roles](#native-claude-code-and-kiro-roles).
One spawn may also select another harness for a named role with `harness`; see
[Spawn-time harness selection](#spawn-time-harness-selection).
Any other `cli` value, and the removed `cli-model` field, fail before Herdr
creates a pane or worktree.

Optional prerequisites fail closed and are not bundled:

- `visual-tester` needs an external `chrome-cdp` skill that provides `scripts/cdp.mjs`.
- `researcher` needs the [`pi-web-access`](https://www.npmjs.com/package/pi-web-access) package for `web_search`, `fetch_content`, `get_search_content`, and `source_check`; Pi ignores missing tool names, so without it the role reports the missing package instead of researching.
- Adversarial review needs a resolved standalone `reviewer` role, confirmed human-only authorship or known author model families, and enough distinct exact authenticated Pi models to satisfy project author-family exclusion and cross-family verification. Routine discovery uses two distinct IDs; concrete high-risk surfaces use three distinct lenses. The parent materializes pinned evidence before public fan-out. A project-approved reduced topology must disclose omitted coverage.
- `/plan` uses the bundled scout and planner roles and records ordered tasks in
  `plan.md`; it does not require a researcher role, todo tool, or `write-todos` skill.

This package does not install optional prerequisites.

Bundled agents use model defaults from `config.json` when configured; otherwise
they inherit the parent model. Thinking defaults still come from agent
frontmatter or the parent level. This resolution chain remains available as a
fallback, but orchestrators should explicitly set each child's exact
authenticated `provider/model-id` and supported thinking level. Select the
model tier first: fast for bounded mechanical work and recon, mid for ordinary
implementation or review, and frontier for architecture, security, hard
diagnosis, or adversarial review. Then select thinking within that model's
supported range. Cross-family independent review requires a reviewer from a
different model family than the author. For ordinary review, prefer a different
authenticated model family. When no other authenticated model family is
available, ordinary review may use a same-family reviewer in a fresh standalone
session. Disclose that this review is context-isolated, not cross-family
independent. Cross-family verification, `/skill:orchestrate`, and
`adversarial-reviewer` must not use this fallback. A stronger model in the same
family is a quality escalation, not cross-family
independent review. Family is the independence boundary; project policy may
separately require a different provider.

Discovery loads definitions in **package → global → project** order, so effective
priority remains **project** (`.pi/agents/`) > **global**
(`$PI_CODING_AGENT_DIR/agents/`, defaulting to `~/.pi/agent/agents/`) >
**package**. Package definitions include bundled roles and roles contributed by
installed Pi role packs. Both `subagents_list` and `/subagent list` show each
visible definition's source; contributed roles include their package identity,
for example `(package:@acme/security-roles)`. A hidden higher-priority definition
still suppresses a visible lower-priority definition.

Custom roles and installable role packs are the package's main extension points.
See [Custom Agents](#custom-agents) for the complete create, package, verify, and
launch workflow.

---

## Async Subagent Flow

```
1. Agent calls subagent()          → returns immediately ("started")
2. Sub-agent runs in herdr pane    → widget shows live status
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as a normal completion/failure
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently — each steers its result back independently as it finishes. Active watchers survive parent `/reload`, `/new`, `/resume`, and `/fork` transitions, so completion is delivered into the replacement session. Quitting Pi still stops parent-side delivery. The live widget above the input tracks every agent still in flight:

```
╭─ Subagents ──────────────────── 1 active · 2 open ─╮
│ 01:23  Scout: Auth (scout)             active · read 7m │
│ 00:45  Reviewer (reviewer)                   stalled 4m │
│ 00:12  Scout: DB (scout)                      starting… │
╰─────────────────────────────────────────────────────────╯
```

Completion messages render with a colored background and are expandable with `Ctrl+O`. Results larger than 16,000 characters are abbreviated in the parent context while preserving their beginning, conclusion, and session path; the complete result remains in the child session. The extension includes that bounded result and a continuation instruction directly in the single custom `subagent_result` message that triggers or steers Pi, avoiding empty turns caused by a separate context-free wake-up. The renderer uses the unadorned bounded result from structured details. Completed rows are removed from the widget as soon as their result is delivered or suppressed.

### In-progress status updates

The widget projects each sub-agent from a **process + turn lifecycle**:

- **Herdr pane inspection** is the coarse authority for whether the child process is present and whether Herdr reports it as idle, working, blocked, or done.
- **Child activity snapshots** enrich the label with Pi-only detail (tool name, streaming, etc.) when available.
- Session JSONL is still used for transcript, resume, lineage, and result extraction — not for liveness.

Projected labels include:

- `starting` — launched; pane/activity confirmation is still settling
- `active` — processing work (agent turn, provider request, streaming, or tool execution)
- `blocked` — Herdr reports the child as blocked
- `waiting` — turn finished; the process is intentionally open for more input or another stage
- `interrupted` — the current turn was cancelled (Escape / `subagent_interrupt`); the process stays open and is **not** treated as active processing
- `stalled` — pane inspection is unhealthy long enough that the parent can no longer trust the run
- `running` — fallback when only coarse process presence is known (e.g. non-Pi backends)
- `finalizing` — completion was observed and delivery is in progress; the process elapsed timer freezes here

The widget header counts **active** vs **open**:

- **active** — `active`, `starting`, `running`, or `blocked`
- **open** — everything else still tracked (`waiting`, `interrupted`, `stalled`, `finalizing`, …)

When `activeCount === 0` (every tracked row is open), the border uses an amber accent. Process elapsed time (`MM:SS` on the left) freezes when the process reaches finalizing/completed/failed. Interrupt does **not** freeze that process clock; the interrupted state shows its own duration on the right while the process remains open.

A fixed internal watchdog marks a run as `stalled` when pane inspection fails or the pane disappears without a completion sidecar; valid long-running `active` or `waiting` states do not become `stalled` just because time passes. When a run enters `stalled` or recovers from it, the parent agent receives a steer message so it can react. All other status transitions stay in the widget only.

**Interactive subagents stay silent.** Long-running user-driven subagents (e.g. `planner`, or any `/iterate` fork) do not wake the parent session on `stalled`/`recovered` transitions — the user is working directly in the subagent's pane, and a steer message there would just burn an orchestrator turn on a no-op "still waiting" ping. The widget still updates normally, and activity snapshots are still recorded/classified regardless of the `interactive` setting. By default, agents with `auto-exit: true` are treated as autonomous and get stall pings; agents without it are treated as interactive and stay quiet. Override per-agent with `interactive: true|false` in frontmatter, or per-spawn with `interactive: true|false` on the tool call.

#### Configuration

The durable user configuration is `$PI_CODING_AGENT_DIR/herdr-agents/config.json`,
defaulting to `~/.pi/agent/herdr-agents/config.json`. It is not read from the
installed package root, so npm and git package upgrades do not overwrite it.
Create it by copying the installed package's `config.json.example`, or run
`/subagents-init` to seed and draft model task preferences. This is a breaking
migration: manually move an existing package-local `config.json` to this path,
or re-run `/subagents-init`.

```json
{
  "status": {
    "enabled": true
  },
  "autoRouting": {
    "version": 1,
    "mode": "off"
  },
  "models": {
    "agents": {}
  },
  "roles": {
    "bundled": true
  },
  "persistent": {
    "maxAgents": 3
  },
  "supervision": {
    "forcePolling": false,
    "hangWarningMinutes": 15
  },
  "panes": {
    "mode": "grouped",
    "direction": "right",
    "maxPerTab": 4
  }
}
```

If `config.json` is absent, status, role, pane, and persistent-specialist settings fall back to `config.json.example`.
Model routing does not read the example: no model overrides apply until a real
`config.json` exists.

The copyable example is model-neutral, so it works without requiring credentials
for a specific provider. To configure models, replace the empty section with
exact IDs from your authenticated model catalog:

```json
{
  "models": {
    "default": "your-provider/your-default-model",
    "agents": {
      "scout": "your-provider/your-fast-model",
      "reviewer": "your-provider/your-review-model"
    },
    "tasks": {
      "coding": ["your-provider/your-coding-model"],
      "review": ["your-provider/your-review-model"],
      "recon": ["your-provider/your-fast-model"],
      "qa": ["your-provider/your-qa-model"],
      "architecture": ["your-provider/your-architecture-model"],
      "docs": ["your-provider/your-docs-model"]
    },
    "tasksMeta": {
      "generatedAt": "2026-09-17T00:00:00Z",
      "method": "research"
    }
  }
}
```

Native `cli: claude|kiro` roles never use these Pi provider/model refs. Their
`task:<category>` values resolve from a separate `models.native` section of
ordered native CLI model IDs, edited by hand (the writer below preserves it):

```json
{
  "models": {
    "native": {
      "claude": { "tasks": { "coding": ["opus", "sonnet"], "review": ["opus"] } },
      "kiro": { "tasks": { "coding": ["claude-sonnet-4.5"] } }
    }
  }
}
```

`models.tasks` candidates are ordered exact authenticated IDs. Use
`task:<category>` only in the `subagent` tool's `model` argument; it is not
valid in frontmatter or model defaults. Cross-family independent review requires
a reviewer from a different model family than the author. For ordinary review,
prefer a different authenticated model family. When no other authenticated
model family is available, ordinary review may use a same-family reviewer in a
fresh standalone session. Disclose that this review is context-isolated, not
cross-family independent. Cross-family verification, `/skill:orchestrate`, and
`adversarial-reviewer` must not use this fallback. Use an exact authenticated
shortlist `provider/model-id` when the
authoring family is known; `task:review` does not establish independence. Family
is the independence boundary; project policy may separately require a different
provider. This is guidance, not extension enforcement.

Task preferences and manual APIs do **not** enable or authorize automatic input
routing. `/subagents-init` and `subagents_write_task_models` preserve unrelated
valid `autoRouting` semantics without granting consent or approving tuples.
The task writer rejects duplicate-member ambiguity in `autoRouting` (including
a repeated top-level section) in either the current file or example source before
any temporary write/rename; it never repairs ambiguous approval JSON.

Run `/subagents-init [preferences]` to draft task-model preferences. For example:

```text
/subagents-init Prefer capability over price for implementation; keep recon inexpensive
```

The command supplies a sanitized snapshot of **all available models from the
active session registry**, including extension-registered providers, exact IDs,
display names, reported base token costs, context/output limits, input
modalities, reasoning, and supported thinking levels. Safe extension-registration and auth-source
metadata is included when Pi exposes it; credentials, endpoints, and raw auth
labels are not. Configured authentication does not prove account access or a
successful request. Missing costs remain unknown; reported zero does not mean
free, and OAuth does not establish subscription billing. The brief uses compact
JSON without truncating models and reports its model count and JSON character
count (not a token estimate); large catalogs still consume context. This is the
current synchronous snapshot: a dynamic provider whose initial catalog refresh
has not completed might be absent. Init does not refresh providers or probe the
network for availability.

The draft considers current saved task, default, and per-agent preferences.
Optional command arguments set ranking preferences. Otherwise it favors
capability for substantive work and efficiency for bounded reconnaissance and
test execution. Categories describe work, not complexity tiers:

| Category | Work |
| --- | --- |
| `coding` | Implementation workers |
| `review` | Code reviewers |
| `recon` | Reconnaissance scouts |
| `qa` | Software and test runners |
| `architecture` | Planning and diagnosis |
| `docs` | Documentation workers |

Init asks the agent to research major candidates across providers using primary
sources, disclose uncertainty and notable exclusions, and avoid duplicate
upstream models across routes unless deliberate redundancy is explained. Display
names help identify candidates but, like aliases, do not prove upstream
equivalence; research is still required. Price or context size alone is not
quality evidence. It reports `registry-only` when
search is unavailable or yields no usable evidence; no live model probes run.

The writer validates and atomically replaces `models.tasks` and `tasksMeta`,
preserving unrelated settings. Its tool schema accepts partial nonempty
categories (omitted categories are removed), rejects empty `tasks: {}` input,
and rejects exact duplicate refs within a category after trimming;
IDs remain case-sensitive. Its result includes normalized saved `tasks`,
`tasksMeta`, `configPath`, and `missingCategories`. Init requests all six categories
and a before/after table based on that saved result, not the unsaved draft. It
must explain missing categories or changed choices; with no available models,
it must report the limitation without writing.

`task:<category>` values select subagent models; they are not slash commands and
do not change the parent model. Ordered authenticated candidate plans resolve
before launch. Ordinary nonpersistent runs can retry later candidates after
launch failure or after a running child settles with a provider/agent error,
not after a completed negative task result. Persistent specialists do not
advance after a running-child error. This is not per-step routing; worktrees
use the first authenticated candidate only, without fallback retries.
Shortlists do not enforce reviewer independence. Cross-family independent
review requires a reviewer from a different model family than the author. For
ordinary review, prefer a different authenticated model family. When no other
authenticated model family is available, ordinary review may use a same-family
reviewer in a fresh standalone session. Disclose that this review is
context-isolated, not cross-family independent. Cross-family verification,
`/skill:orchestrate`, and `adversarial-reviewer` must not use this fallback.
Another route to the same family is not
independent review. Family is the independence boundary; project policy may
separately require a different provider. Run `/reload` (or start a new session)
after writing preferences.

Set `persistent.maxAgents` to the maximum concurrently retained persistent specialists. It defaults to `3`; a persistent spawn at the cap is rejected before Herdr creates a pane or workspace, and no specialist is evicted.

Set `roles.bundled` to `false` to exclude this package's bundled role definitions from listing and exact-name launch. It defaults to `true`. Registered role packs remain available, and global and project definitions keep their existing precedence. A role-pack name collides with a bundled role only while that bundled layer is enabled; when it is disabled, the role pack can supply that name.

### Supervision transport

On supported local filesystems, supervision uses file wake-ups plus one shared
4.8-second pane reconciliation. A wake-up only prompts fresh evidence
collection; it never establishes a result by itself. If the watcher or shared
pane inspection becomes unavailable, supervision quietly returns to the legacy
one-second polling cadence. No caller action is required.

Set `supervision.forcePolling` to `true` in the durable user `config.json` to
disable wake-ups and use that legacy cadence deliberately. The setting is read
when the coordinator is created, so run `/reload` after changing it.
`subagents_list` reports the active transport mode (`wake+batch`,
`polling(forced)`, or `polling(fallback)`) and watcher count.

`supervision.hangWarningMinutes` defaults to `15`; set it to `0` to disable
no-progress advisories. For example, this keeps the default transport and sets
a 30-minute advisory budget:

```json
{
  "supervision": {
    "forcePolling": false,
    "hangWarningMinutes": 30
  }
}
```

While a child projects active or blocked, the parent compares durable session
JSONL and activity-snapshot updates against this budget. An advisory is warning-only, fires once per no-progress episode, and
never interrupts, kills, retries, or restarts a child. It identifies `blocked-tool` (an outstanding tool call may still complete),
`truncated-turn` (an observed `toolUse` stop with no tool call; its cause is unknown), or
`generic-no-progress` when neither condition is established, then
includes the session path and manual recovery options. Ordinary children can be
interrupted or, after manual termination, resumed or newly spawned. Persistent
ordinary-pane specialists can be interrupted or stopped with `subagent_stop` and
replaced; they cannot be resumed. Managed-worktree children, including persistent
ones, retain their workspace and continue there only after the previous process
has exited; do not use `subagent_resume` or start a concurrent writer. Interactive children stay
quiet just as they do for stalled/recovered notices; their widget state still
updates. A later durable update clears the episode and sends the corresponding
recovered notice for non-interactive children.
`polling(fallback)` means at least one tracked child is using per-child polling;
other children can still use wake+batch.

A Linux manual benchmark on 2026-09-06 used isolated Herdr panes held pending,
20-second windows, and the extension's completion/supervision seams. At 10
children across three rotated rounds, wake+batch averaged 2.20 CLI launches/s
versus 14.20 for forced polling (84.5% fewer); mean evidence-to-resolver
latency was 3.2 ms versus 449.0 ms, and the largest reconciliation probe gap
was 4.82 s. The benchmark measures `/proc` CPU ticks for the supervisor and
isolated Herdr tree, not parent-model latency; raw samples are written to
`/tmp/issue29-bench/` by `test/bench/supervision-bench.mjs`.

`panes.mode` defaults to `"grouped"` when omitted. Ordinary public `subagent` and `subagent_resume` launches, including bare forks and `/iterate`, fill extension-owned `Agents`, `Agents 2`, etc. tabs in the target checkout's existing workspace. `panes.maxPerTab` is a positive safe integer, defaults to `4`, and counts all live panes in each owned tab, including user-added panes and retained shells. Overlapping launches in one parent respect this cap. It is independent of `persistent.maxAgents`.

Checkout matching uses Herdr's canonical `worktree.checkout_path` and includes descendant directories. Shell working directories do not establish workspace ownership. If no checkout matches (including non-Git directories), placement uses the caller's workspace; overflow never creates a workspace. A reviewer with `cwd` set to a managed checkout joins that workspace without creating another worktree. Resume placement uses the saved session's cwd.

Explicit `panes.mode: "tab"` preserves one new tab per ordinary child in the caller's workspace. Explicit `"split"` preserves splits of the stable parent pane. `panes.direction` is `"right"` (default) or `"down"` and applies to grouped and legacy splits. `maxPerTab` does not affect these legacy modes. Managed worktrees retain their separate workspaces, while `/btw` keeps its existing tab behavior.

Ownership is tracked by returned pane/tab/workspace IDs, never labels. Separate parent processes own separate groups; `/reload` preserves a parent's in-memory ownership, but a full restart does not adopt old tabs. Placement never moves existing panes or renames user tabs. Background launches preserve focus; Herdr may resize sibling panes when splitting or closing. User-added panes are never closed by automatic tab cleanup. An owned tab remains reusable while user panes remain, even after all child panes close.

Run `/reload` after changing role, model, or pane settings.

`models.default` sets the model for subagents that do not specify a model.
`models.agents` sets per-agent defaults, keyed by the agent name passed to
`subagent({ agent: ... })`. Explicit `model` tool arguments take precedence,
followed by agent frontmatter, per-agent config, the global default, and finally
the parent model. Model values must be exact authenticated `provider/model-id`
references. A value can contain an ordered comma-separated fallback list, for
example `provider/preferred, provider/fallback`. The tool argument also accepts
`task:<category>` as its complete value (not in a list), for configured
`coding`, `review`, `recon`, `qa`, `architecture`, or `docs` preferences. The extension validates every
candidate before launch, then launches later candidates only after the selected
child settles with a provider/agent error. Pi owns any automatic transient
retrying inside that child; the extension does not infer retry counts or
permanence from the error text. A completed child result, including a negative
task result, never switches models. Completion metadata reports the requested
candidate, every attempted candidate, the model actually used, and each raw
model failure in attempt order when fallbacks are tried.

A catalog-listed model and configured authentication do not prove that the
active provider account can use that model. Providers may reject an account /
model combination only when the request is made. The completion preserves each
raw provider reason with its model and suggests checking account access,
spawning a new subagent with a supported model, or choosing an appropriate
configured fallback. `subagent_resume` does not select a model and should be
used only after the session's stored model is usable. Persistent session sidecars fail closed: v1 does not resume or revive a stopped or crashed specialist; retain its evidence and spawn a new specialist. The completion does not
claim a permanent failure or a retry count that Pi has not exposed. Reliable
structured permanence and retry counts require an upstream Pi/ExtensionAPI
diagnostics seam for final provider errors and retry outcomes.

`config.json` is durable user state under the Pi agent directory and is loaded
when the extension starts. Run `/reload` after changing it. Package-root
`config.json` files are ignored; move them manually or re-run `/subagents-init`.

---

## Automatic input routing

Automatic routing v1 is a **package-only public Pi 0.99.1 contract**, not a
host patch or an external gate. It leaves the parent model/thinking unchanged
and uses existing launch, supervision, bounded result delivery, and parent
synthesis. [ADR-0014](docs/adr/0014-jev-auto-input-dispatch.md) records the
architecture, alternatives, threat model, and residual risks.

### Eligibility and current-view limits

Only eligible **idle top-level TUI** events with `source: "interactive"` and
**undefined `streamingBehavior`** may route. The parent must have no pending
messages or managed child/uncertain launch, be inside Herdr, and have an existing
persisted session on disk. A fresh/unpersisted session's first prompt bypasses;
the package does not force persistence. Required public APIs must be available.
Missing compatibility or invalid config disables routing, not manual tools.

RPC (including fresh prompts and idle steer/follow-up), JSON, print,
extension-source input, and streaming `steer`/`followUp` **bypass in every mode**.
So do child/BTW/handoff sessions, visible `/` or `!` commands, blank text,
current images (including mixed text/images), oversized or locally unsafe text,
and `[no-auto-route]` when still visible. Manual `subagent`, `/subagent`,
resume/send, `/plan`, `/iterate`, `/btw`, `/worktree`, and task selectors never
consult Jev. Substantive prose need not say “delegate”; explicit runtime choices,
parent-only work, earlier-context dependence, multi-child/independent review, or
external actions instead require ordinary parent/manual handling.

**This handler's view is the only input contract.** Earlier handlers can expand
files/history into text or remove images, commands, or an opt-out marker; that
transformed text may be sent. The router itself does not open references or add
prior conversation for classification. There is no original-input provenance,
physical-ingress authenticity, first/last ordering, or universal secret-screening
guarantee. Earlier handlers may consume input; returning `handled` prevents
later handlers (including their security checks) and normal expansion from
running. `continue` lets later handlers transform it further. Operators must
review installed input extensions and their ordering; disable routing if this
composition is unacceptable. TUI/interactive labels cannot distinguish a
physical gesture from SDK/startup input carrying the same labels.

### Consent, egress, and execution authority

Absent config or `mode: "off"` sends nothing to Jev. **Every non-off mode,
including shadow, requires explicit durable administrator consent.** An input
prompt, model shortlist, or classifier answer cannot grant it.

Eligible current prompt text plus reviewed compact role/runtime profiles go to
TypeSafe AI at the fixed `https://api.typesafe.ai/v1/systemone` endpoint. Pasted
or earlier-expanded content may be confidential. TypeSafe's no-training statement
is **not zero retention or a residency guarantee**; verify your agreement before
sending private data. The child and parent retain normal provider and local
session behavior. No separate history, repository inventory, role/skill body,
credentials, or endpoints are classifier state fields, but earlier expansions
can already be present in the current prompt.

The public Pi authenticated classifier seam sends exactly `typesafe` /
`jev-1.13.0`, with `jev-auto-questions-v1` and `jev-auto-v1`, at most two batches,
zero retries, and one A+B/auth deadline (initial recommendation 5000 ms).
An immutable copy of the built-in `jev-latest` descriptor can supply transport
when the pin is not catalog-listed; the outgoing request is still the exact pin,
never latest. A bounded wire observer checks returned model, full distributions,
and adapter agreement; incompatible evidence is unavailable, never permission.
Auth comes from Pi's TypeSafe authentication or `TYPESAFE_API_KEY`; auto config
accepts **no credentials or endpoint override**. Bounds: current prompt 8 KiB,
batch body 24 KiB, state plus longest question 16 KiB, response 64 KiB. No silent
truncation or candidate trimming. Normal receipts contain bounded versions,
IDs, hashes, reasons and timings, not prompt/probability dumps.
Unpriced/zero catalog cost is not a free-service claim.

An explicit allowlist authorizes each **exact role + harness + model + effort**.
Jev is untrusted evidence, never authorization. Resolve normal project > global >
package discovery first, then verify the reviewed full role/provenance SHA-256.
Changed/overridden roles require deliberate reapproval; skill/config/runtime
changes invalidate snapshots. No name-based assumptions about model quality,
family, independence, price, or capability. Declared tiers/families and strengths
need administrator evidence. Choice confidence/probability/margin, absolute fit,
semantic gates, and both complete Score distributions are checked conjunctively;
upper-tail/low-confidence effort conservatism can abstain rather than downgrade.
Effort buckets are policy floors, **not portable vendor token budgets**.

The tuple explicitly authorizes replacing role runtime defaults or projecting to
another harness; manual pinned-role projection still needs an explicit destination
model. Pi exact physical chat refs must have configured auth/text input/supported
exact thinking; no clamping, task alias, fuzzy ref, or fallback list. Native IDs
are separate exact versioned CLI IDs, not aliases/defaults or Pi refs; account
access/effort capability require admin evidence, not Pi authentication inference.
Existing native prerequisites, tool/skill projection, and prompt-mode rules still
apply. All relevant feasible candidates are revalidated before resources/dispatch.
Current effort floors use the configured `effortQuantile` (default .90) of each
full reasoning/consequence Score distribution and their maximum; mass at level 3 of at least .10 or low Score
confidence raises band 3. Minimum tier/effort bands are fast/0, mid/1,
frontier/2, frontier/3. Pi off/minimal/low map to 0, medium to 1, high to 2,
xhigh/max to 3; native uses low/medium/high/xhigh-or-max respectively. Confident
explicit equivalence uses administrator rank, not inferred cheapness.

Children are named, standalone, autonomous, nonpersistent **ordinary-pane leaves
in the current shared checkout**. V1 rejects/never creates worktrees and grants
no fork, fan-out, nesting, extra tools/skills, auto commit/push/deploy, or external
action permission. Report roles with Bash are not sandboxed read-only. Manual
or other-process work can conflict; the slot is not a machine-wide lock.
Review-purpose roles (including reviewer responsibilities) always abstain under
v1 strict review policy, even if configured/evaluated in shadow: no trusted
pinned authorship input exists. Use the parent/manual review workflow.
Auto children inherit a recursion guard and unset `TYPESAFE_API_KEY` in the launch
command. This Jev-key hygiene is **not OS secret isolation**: same-user tools,
processes, shells and auth files remain accessible.

### Durable schema and operator workflow

Edit only `$PI_CODING_AGENT_DIR/herdr-agents/config.json` (default
`~/.pi/agent/herdr-agents/config.json`), top-level `autoRouting`. The copyable
example is deliberately only `{ "version": 1, "mode": "off" }`, with no consent
or tuples. No public approval/config writer or fingerprint-generation wizard is
provided; `/subagents-routing status` diagnoses loaded state, not approvals.

| Field | Contract |
| --- | --- |
| `version`, `mode` | `1`; `off`, `shadow`, `pilot`, or `auto`. Off can retain a complete valid enabled-form config, but partial retained fields are invalid. |
| `policyVersion`, `questionVersion` | Required when enabled: `jev-auto-v1`, `jev-auto-questions-v1`. |
| `consent` | Required: `disclosureVersion: "jev-egress-v1"`, strict ISO-8601 `acknowledgedAt`, `sendCurrentPromptAndReviewedProfiles: true`; record only after accepting this disclosure. |
| `jev` | Required: `provider: "typesafe"`, `model: "jev-1.13.0"`, integer `timeoutMs` 500–15000. |
| `failurePolicy` | `parent` (default) or `hold`; see ownership rules below. |
| `thresholds` | Optional complete object; defaults below. Only more conservative v1 values allowed. |
| `roles` | 1–16 approvals; each needs at least one tuple. |
| `candidates` | 1–128 exact approved tuples; no duplicate role/harness/model/effort. |

Each role approval has `id`, exact discovered `agent`, `source`
(`project|global|package`), `definitionSha256` (64 lower-case hex of the shipped
versioned canonical full resolved role and provenance), `labelRole`
(`plan|research|ui|api|build|test|review|browser|security|perf|merge`),
`intent` (`report|modify`), `purpose` (`task|review`), and reviewed
`responsibility`, `deliverable`, `excludes`. Contributed package roles also need
both `provider` and `providerVersion`. Review responsibilities must use purpose
`review`. Do not hash only the role body or blindly approve a changed hash.

Each candidate has `id`, `roleId`, `harness` (`pi|claude|kiro`), `model`,
`effort`, `tier` (`fast|mid|frontier`), reviewed upstream `family`,
`taskStrengths`, `limitations`, `capabilityEvidence`, and `preference`.
Pi model is `{namespace:"pi", ref:"provider/model-id"}`; native model is
`{namespace:"claude"|"kiro", id:"<exact-versioned-cli-id>"}` matching the harness.
Pi effort is `off|minimal|low|medium|high|xhigh|max`; native excludes off/minimal.
Preference is integer 0–10000, unique within role/harness/model. IDs match
`^[a-z][a-z0-9-]{0,39}$` and cannot use reserved IDs such as `none`/`equivalent`.
Profile strings are nonempty/control-free and at most 256 UTF-8 bytes; model
refs/IDs 200, family 80, capability evidence 512. Aggregate payload limits still
apply; a large valid catalog can be unavailable for a particular prompt.

Threshold defaults (ranges): `choiceConfidence` .80 (.80–1),
`choiceProbability` .70 (.70–1), `choiceMargin` .20 (.20–1),
`absoluteFit` .80 (.80–1), `falseCeiling` .20 (0–.20), `trueFloor` .80 (.80–1),
`scoreConfidence` .80 (.80–1), `effortQuantile` .90 (.90–.99).
`falseCeiling < trueFloor`; full Score upper tails are used, never just means.
Unknown keys, duplicate JSON members/IDs, prototype keys, wrong types/nulls,
nonfinite/out-of-range values, moving aliases, credentials, endpoints, and launch
bags (`tools`, `skills`, `cwd`, `worktree`, etc.) are rejected. Hidden,
interactive, persistent, non-standalone, unrestricted or spawning roles are
ineligible, not silently rehabilitated.

Review exact role/provenance fingerprints, installed skill/tool compatibility,
physical model/native access evidence and compact profiles locally before
writing approvals. Reapprove actual policy changes deliberately. After edits,
`/reload` loads the snapshot; durable digest drift/deletion/revocation blocks
later egress/launch until reload. Invalid routing config disables only routing.
Enabled sessions show a startup disclosure/status indicator without a Jev call.
There is no automatic refresh, live probe, consent shortcut, or auto opt-in by
`/subagents-init`, manual APIs or task model preferences.

### Ownership, persistence, cancellation, and recovery

A synchronous **in-flight decision slot is not request ownership**. Safe unowned
abstention/unavailability under parent policy returns `continue`, with ordinary
parent handling and no replacement turn. `hold` consumes without execution.
Shadow reserves an observational slot and returns `continue` immediately; it
never owns the request, launches, changes runtime, sends suggestions/context
messages, or wakes the parent. Normal parent work does not cancel shadow;
observable navigation/reload/local cancel and the deadline still bound it.

Selected pilot/auto takes irreversible ownership **before** attempting a custom
`jev_auto_request` append: every subsequent path returns `handled`, including
errors. The message is labeled “User request · automatic delegation ·
handler-visible text”, records the exact captured request losslessly, and means
awaiting execution, not already started. Public branch/message observations plus
bounded read-back of the existing session file must verify that exact entry on
the current branch **before resources/dispatch**. `sendMessage` returns void;
this is ordinary on-disk verification, **not fsync or atomic persistence plus
execution**. The custom message enters normal model context/export/reload but
is not an ordinary user node in `/fork`'s user-message picker.

Pilot adds a bounded TUI confirmation (30 seconds) showing exact role origin,
harness/model/effort and shared-checkout behavior; decline/timeout holds, never
approves by default. `jev_auto_status` reports actual state/child identity and
exact runtime after launch. Existing `subagent_result`/`subagent_ping`,
supervision and replacement-parent delivery remain unchanged; completion is a
review handoff, not acceptance. Automatic metadata uses `selection.harnessSource: "auto"`, per-field provenance
and an `autoRouting` receipt, not a claim that the
user requested those runtime fields. Non-context `jev_auto_route_v1` entries are
bounded decision receipts, not durable task execution acknowledgements.

Only **positively known no-dispatch**, verified-persistence, current-session
owned failures can attempt parent fallback once (`fallback-attempted`, not proof
of parent execution). Uncertain dispatch, recording failure, observed cancel,
stale context or unexpected owned errors hold; unknown is never no-work.
There is no alternate automatic child route or automatic replay/retry/adoption.
A package decision ID is correlation only, **not host submission identity or
cross-process exactly-once**. Repeated identical submissions are distinct
decisions. The live latch only prevents repeated dispatch within one decision.

A crash before persistence can lose pending handler input; after recording it
can leave a request with no work, or work running without a started receipt,
or uncertain fallback delivery. Session append, launch, delivery and `handled`
are not one host transaction. Unknown owned/launching records block new automatic
work on the active branch. Inspect cited session/child resources, establish
whether anything still runs, recover explicitly with existing manual lifecycle
tools, and use a fresh session for further auto work only after prior work is
accounted for. Do not infer safe retry from missing receipts or resend unknowns.

Use `/subagents-routing status` for loaded mode/drift, pending decision/ownership,
busy/unknown recovery state and limitations. There is **no routing status tool**.
`/subagents-routing cancel` cancels preflight/pilot only **when observable**; it
cannot stop an already dispatched child (use existing `subagent_interrupt` and
manual recovery). Observed lifecycle/session events and the classifier deadline
bound package waiting, but **idle Escape is not reliable cancellation**.
Real Pi 0.99.1 TUI evidence observed Escape followed by `jev-timeout`, not cancel.
It also queued the local cancel command and public `newSession` until the awaited
input resolved: those two pre-dispatch integration scenarios are explicit
blockers/skips, **not passes**. No host patch or private-hook substitute fixes
this contract. Off/reload blocks later egress/launch and cancels pending decisions
when lifecycle change is observed; it does **not retroactively stop children**
or undo already sent data. New prompts while a child runs use ordinary parent
handling, not an automatic child queue.

### Rollout and rollback

Progress deliberately: **off → offline fake transport → consented shadow →
consented pilot → auto**. Fake transport is test infrastructure, not a production
config mode/endpoint. Begin pilot with a small reviewed report-task allowlist;
expand modify/native tuples only after their own evidence. Shadow does not prove
ownership/dispatch safety. Thresholds, latency budget and model-quality profiles
remain **synthetic/unmeasured/uncalibrated**; T11 fixture scores prove mechanical
consistency, not achieved TypeSafe service or execution-model quality. The
[offline evaluator guide](test/evals/jev-routing-README.md) describes commands
and frozen splits (development-only, excluded from the package). Separate live
capture requires explicit informed egress consent and remains outside the
package; normal tests/integration never call live Jev.

Promotion needs deterministic safety gates, measured workload/pilot evidence and
administrator acceptance of privacy, extension composition, shared-checkout and
crash risk. Roll back by setting off and reloading; retain/inspect any dispatched
child under its existing lifecycle. No threshold supplies universal read-only,
secret isolation, zero retention, reliable Escape, original provenance, stable
submission identity, a host transaction, cross-process exactly-once, or RPC
routing guarantees.

---

## Spawning Subagents

```typescript
// Explicit fast-tier runtime for bounded reconnaissance
subagent({ name: "Scout", agent: "scout", model: "<provider>/<fast-tier-id>", thinking: "low", task: "Analyze the codebase..." });

// Force a full-context fork for this spawn
subagent({ name: "Iterate", fork: true, model: "<provider>/<mid-tier-id>", thinking: "medium", task: "Fix the bug where..." });

// Explicit frontier-tier runtime for architecture work
subagent({ name: "Planner", agent: "planner", model: "<provider>/<frontier-tier-id>", thinking: "high", task: "Work through the design with me" });

// A named Pi role run once on native Kiro; the model is a native Kiro ID
subagent({ name: "Kiro scout", agent: "scout", harness: "kiro", model: "<kiro-model-id>", thinking: "low", task: "Map the flow" });

// Explicit mid-tier runtime with a custom working directory
subagent({ name: "Designer", agent: "game-designer", model: "<provider>/<mid-tier-id>", thinking: "medium", cwd: "agents/game-designer", task: "..." });

// Isolated ticket branch in a Herdr-managed Git worktree
subagent({
  name: "Ticket 123",
  agent: "worker",
  model: "<provider>/<mid-tier-id>",
  thinking: "medium",
  worktree: { branch: "ticket/123", base: "main" },
  task: "Implement ticket 123, test it, and commit the result",
});
```

### Parameters

| Parameter              | Type    | Default        | Description                                                                                       |
| ---------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `name`                 | string  | required       | Short stable child label; coordinated groups use `<task>-<role>[-n]` (widget and pane title)      |
| `task`                 | string  | required       | Task prompt for the sub-agent                                                                     |
| `agent`                | string  | —              | Load defaults from agent definition                                                               |
| `harness`              | `"pi"` \| `"claude"` \| `"kiro"` | role `cli`, else `pi` | Run the named role on this harness for this spawn; requires `agent`. Effective harness: `harness` → role `cli` → `pi`. A different harness than the role's own is a validated projection; see [Spawn-time harness selection](#spawn-time-harness-selection) |
| `fork`                 | boolean | —              | Override the child session mode: `true` forces fork, `false` forces standalone. Omit to inherit the agent `session-mode` frontmatter |
| `persistent`           | boolean | `false`        | Keep one specialist session alive for sequential tasks; follow-ups use `subagent_send` only       |
| `interactive`          | boolean | derived        | Mark this spawn as interactive (don't wake the parent on stall/recovery). Defaults to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`. |
| `model`                | string  | configured or parent | Exact authenticated `provider/model-id`, ordered fallback list, or whole-value `task:<category>` (coding, review, recon, qa, architecture, docs). Task routing is tool-only; worktrees use its first authenticated candidate. Resolution is tool argument → agent frontmatter → per-agent config → global config → parent. When the effective harness is `claude` or `kiro`, the value is native CLI model IDs instead (see [Native models and fallback](#native-models-and-fallback)); a role's frontmatter model applies only on its own harness |
| `thinking`             | string  | parent level   | Pick the model tier first, then set thinking within that model's range: minimal/low for bounded mechanical work, medium for ordinary implementation or review, high+ for architecture, security, or hard diagnosis. Omitting still inherits the parent level; this is a discouraged fallback for orchestrated children. |
| `systemPrompt`         | string  | —              | Role/system-prompt text for a bare spawn; named agents keep their definition body                  |
| `skills`               | string  | —              | Comma-separated skill names                                                                       |
| `tools`                | string  | —              | Comma-separated tool names                                                                        |
| `cwd`                  | string  | —              | Working directory, or source repository when `worktree` is set (see [Role Folders](#role-folders)) |
| `worktree`             | object \| null | —          | Isolated Herdr-managed Git worktree; requires `branch`, with optional `base` (committed `HEAD` by default). Omit or pass `null` to use an ordinary pane in `cwd` when a client requires the property. |

### Naming coordinated children

Before launching a new group, choose a short task slug and label each new child
`<task>-<role>[-n]`, such as `login-api` or `login-test2`. Roles are `plan`,
`research`, `ui`, `api`, `build`, `test`, `review`, `browser`, `security`,
`perf`, and `merge`. Leave existing labels unchanged. After the final launch,
print `name | agent kind | role | model | worktree` and use each name in
prompts, handoffs, and results.

### Isolated worktree runs

Use one worktree per parallel independent writing task; a single or sequential writer can work in the parent checkout, and read-only agents use ordinary panes. Omit `worktree` for an ordinary pane; clients whose generated tool schema requires every property may send `worktree: null` with the same effect. `cwd` selects the source Git repository, `branch` must be unique, and `base` is resolved to an exact commit before creation. If `cwd` is a linked checkout, Herdr provisioning uses the principal checkout while the requested checkout supplies the base SHA and manifest provenance. A successful launch from that linked checkout does not itself authorize cleanup there: cleanup checks the canonical principal/source repository under the invoking parent session's cwd, not `manifest.sourceCwd` or shared Git identity. If cleanup is needed, start the parent Pi session rooted at the principal checkout or an ancestor containing it, then use the normal explicit cleanup flow; changing directories inside an existing Pi session does not change its session cwd. If `base` is omitted, the source checkout's committed `HEAD` is used. Parent-checkout changes that have not been committed are not copied.

A launch with `worktree` and an effective bundled `scout`, `reviewer`, or `adversarial-reviewer` returns a non-blocking warning. Scouts and reviewers normally need an ordinary pane; the adversarial reviewer is a coordinator that uses an ordinary pane for its child reviewers. To inspect or review an existing worker result, start an ordinary child in that retained worktree path. Project or global role overrides do not receive these bundled-role warnings. A `read,bash` allowlist is not an enforced read-only boundary because shell commands can mutate files; report-only roles must restrict Bash to safe inspection and avoid artifact-generating verification in the reviewed checkout.

The child starts at the returned worktree root. Tell writing agents to test and commit when you want a commit-based handoff, and tell them not to push, merge, switch branches, or remove the worktree. The parent owns review and integration.

Successful, failed, and help-requesting worktree runs retain their workspace and root shell. A reviewer's disposable pane can close without closing that root, tab, or checkout. Completion includes the worktree path, Herdr workspace, branch, base/head SHAs, commits ahead, changed and untracked files, and clean/dirty/conflicted state. Here, `clean` means no uncommitted files; the branch may still contain commits. If Git inspection fails, state is reported as unknown rather than guessed.

An ownership manifest is written under the parent session's `artifacts/<session-id>/worktree-runs/` directory before Herdr creates resources. V1 does not automatically recover watchers after a full process restart, and `subagent_resume` does not reattach the managed worktree lifecycle.

The extension does **not** push, create a PR, merge, cherry-pick, or remove the worktree or branch automatically. For task selection, lifecycle states, review commands, failure recovery, and safe cleanup, read [Worktree subagents](docs/worktree-subagents.md). The [research report](docs/research/worktree-subagent-orchestration.md) records the rationale and deferred roadmap.

---

## Persistent specialists

Set `persistent: true` on a `subagent` launch to create one logical specialist with one v1 session generation. Its resolved tools, denied tools, model, thinking level, and optional worktree binding are snapshotted at launch and do not change when work is sent later. `subagents_list` shows each live specialist's logical ID, generation ID, state, completed-task count, and effective policy.

Native `cli: claude|kiro` roles with `persistent: true` follow the same contract. Their policy hash is the native loadout hash. The parent types a dispatched task once, as a new tagged turn, at the verified idle point that makes the specialist idle. `subagent_stop` types the native graceful exit (`/exit` or `/quit`) only at such a point. Specialist crash and stop notices carry the same facts. Native specialists cannot delegate (`spawn-agents`) and never advance to another model.

The initial task and each `subagent_send({ id|name, message })` task are delivered exactly once with a task ID. A specialist accepts one task at a time. Sends while it is working are recorded as `rejected-busy`; no queue is retained. After a task result arrives, it is idle and accepts the next task. A persistent child's `caller_ping` records a help request but keeps the session alive; answer with `subagent_send`.

Use `subagent_stop({ id|name })` to request graceful shutdown. If a task is active, stop becomes `stop-pending` and the task reaches its terminal outcome first. The parent reports `stopped` only after process-exit evidence is confirmed, then closes an ordinary pane it created and releases the name. If confirmation times out, the specialist is `stalled` in an unconfirmed-stop state: `subagent_send` rejects follow-up work while retaining evidence. Request `subagent_stop` again to make another bounded exit check, or spawn a new specialist. A pane or process disappearance without a stop directive produces one facts-only crash notice; persistent sessions cannot be resumed in v1, so spawn a new specialist. There is no automatic restart, replay, or revival.

A persistent specialist with a worktree holds that lease for its entire lifetime. It cannot be re-bound to another checkout. Otherwise it runs in an ordinary pane.

## Interrupting a running subagent

Use `subagent_interrupt` to cancel the active turn of a running Pi-backed subagent:

```typescript
subagent_interrupt({ id: "abcd1234" });
// or
subagent_interrupt({ name: "Scout" });
```

This sends Escape to the child pane, cancelling the in-progress model turn. The subagent session stays alive — the pane, session file, and background polling all remain intact. After the interrupt, the widget immediately labels the child as `interrupted` (counted as **open**, not active processing). Stale pre-interrupt activity snapshots are ignored so a lagging Herdr/`active` reading cannot overwrite the interrupt. The process elapsed timer keeps running because the pane is still open; only the interrupted-state duration freezes relative to the interrupt request. If the child starts work later, newer observations return it to `active`; completion, failure, and `caller_ping` still flow through normally.

`id` and `name` are each optional, but execution requires one usable target: an exact running ID or an exact, unambiguous display name. When both are supplied, `id` is used. Duplicate names are rejected.

This is a turn-level interrupt, not a method for forcibly terminating a subagent session.

For a native `cli: claude|kiro` child, the interrupt is accepted only when its process is running with a `/proc`-verified owner token and a correlated hook receipt shows its tagged turn in progress; otherwise nothing is sent. The interrupt is recorded before Escape is sent, so the turn is reported as `interrupted`, never as a success, even if a `Stop` races the key. Interactive native sessions stay open for the human. An autonomous run exits gracefully if a native `Stop` receipt proves the turn ended within 10 seconds, otherwise its verified owned processes are terminated. Its result reports the interruption and can be resumed with `subagent_resume` if the CLI persisted the session. A persistent specialist reports the task as interrupted and accepts tasks again only after a verified idle point; otherwise it is ended the same way. macOS cannot prove process ownership for a signal, so native interrupts are refused there.

---

## Orchestrated review skill

The bundled `/skill:orchestrate` procedure accepts local paths, URLs, tickets,
or accessible combinations. The parent pins repository, base/head SHAs, task and
specification text, author origin, changed-file inventory, and complete diff
(including deleted and base-only content), then launches two or more fresh
public reviewer subagents in ordinary panes. Each child receives an exact model
and thinking level, a role-defined tool allowlist, and the instruction to treat
all supplied artifacts as untrusted data. Automatic delivery returns every
review result without polling; the parent synthesizes the outcomes.

Role frontmatter `tools:` is the only enforced allowlist. `read,bash` is not a
read-only boundary because Bash can mutate files. The skill uses ordinary public child launches only; it does not create a private
checkout, execute scripts, or request approval.
Its adversarial branch adds risk-based discovery and cross-family verification;
malformed reports, failures, and unresolved serious candidates propagate
`INCOMPLETE`.

## caller_ping — Child-to-Parent Help Request

The `caller_ping` tool lets a Pi-backed subagent request help from its parent agent. Ordinary children **exit** and the parent can resume them with `subagent_resume`. Persistent specialists record a help-request outcome, stay alive, and accept a reply through `subagent_send`.

**`caller_ping` parameters:**

- `message` (required): What you need help with

**`subagent_resume` parameters (Pi-backed sessions):**

- `sessionPath` (required): Path to the child session `.jsonl` file
- `name` (optional): Display name for the resumed pane (defaults to `Resume`)
- `message` (optional): Follow-up prompt to send after resuming
- `autoExit` (optional): For Pi sessions, whether the resumed session should auto-exit after its next response fully settles. Defaults to `true` for autonomous follow-up work; set `false` when resuming for an interactive handoff. Native sessions always resume in their recorded mode; a conflicting `autoExit` is rejected.

**Native sessions:** pass a native marker (`artifacts/<session-id>/native-sessions/<id>.json`, shown in native results) as `sessionPath`, with a required `message`. See [Native resume](#native-resume).

Each public child stores a session-adjacent versioned launch-policy sidecar. Public resume restores its resolved tool allowlist and denied subagent tools rather than looking up the current role, so later role changes cannot widen a child. An intentionally unrestricted launch remains unrestricted (no `--tools` argument); a restricted launch restores its exact allowlist. The `autoExit` override still controls whether `subagent_done` is available, while `caller_ping` remains available. Missing, malformed, or unsupported policy fails closed before a pane is created with recovery guidance. Public resume rejects managed-worktree child sessions; use their retained workspace instead. Unknown policy owners, including legacy workflow sidecars, fail closed.

**Interaction flow:**

1. Child calls `caller_ping({ message: "Not sure which schema to use" })`
2. Ordinary child sessions exit (like `subagent_done`); persistent specialists stay alive.
3. Parent receives a steer notification: *"Sub-agent Worker needs help: Not sure which schema to use"*
4. The parent resumes an ordinary child with `subagent_resume`, or replies to a persistent specialist with `subagent_send`.
5. The child picks up with the parent's guidance

**Example:**

```typescript
// Inside a worker subagent
await caller_ping({
  message: "Found two conflicting migration files — should I use v1 or v2?"
});
// Session exits here. Parent receives the ping, then resumes this session
// with guidance like "Use v2, v1 is deprecated"
```

> **Note:** `caller_ping` is only available inside Pi-backed subagent contexts. Calling it from a standalone Pi session returns an error. For a worktree child, the help handoff retains the workspace, but `subagent_resume` does not reattach worktree tracking; continue the work in the retained workspace.

---

## The `/plan` Workflow

The `/plan` command orchestrates a full planning-to-implementation pipeline.

```
/plan Add a dark mode toggle to the settings page
```

```
Phase 1: Investigation    → Autonomous scout maps the codebase
Phase 2: Planning         → Interactive planner subagent (user collaborates)
Phase 3: Review Plan      → Confirm ordered tasks, adjust if needed
Phase 4: Execute          → Shared-checkout sequential workers by default; isolated parallel workers for independent tasks
Phase 5: Integrate        → Parent reviews and integrates worktree branches one at a time, only when worktrees are used
Phase 6: Review           → Reviewer subagent checks the integrated changes
```

The parent workspace and tab names stay unchanged. Subagents use the configured placement policy; grouped mode reuses available space in owned Agents tabs.

---

## The `/iterate` Workflow

For quick, focused work without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
```

This always forks the current session into a subagent with full conversation context. It does not inherit an agent default `session-mode`. Make the fix, verify it, and exit to return. The main session gets a summary of what was done.

---

## The `/btw` Workflow

Use `/btw` for a quick side question without adding a turn to the main session:

```text
/btw What did we decide about session cleanup?
```

The extension snapshots the current active conversation branch, opens a non-focused Herdr tab, and starts an interactive Pi session with the same model and thinking level. The answer stays in that tab and is never delivered as a subagent result. A second `/btw` replaces the previous one; `/btw-close` closes it explicitly.

BTW shares the current working directory. It treats inherited work as reference context and modifies the workspace only when the side question explicitly requests it. Cleanup is best effort; if closing fails, the tab remains available for manual recovery.

---

## The `/worktree` Workflow

`/worktree <worktree> [task]` creates a Herdr-managed worktree from the current committed branch and launches a new interactive Pi session there with the active conversation branch. The original session remains available. Use `/worktree list` or `worktree_list({})` to inspect managed worktrees, including cross-session orphans, whose canonical source repositories are inside the session's cwd subtree. This is a new-process handoff, not an in-place move of the existing shell or Pi process.

---

### Explicit worktree cleanup

Parent sessions can call `worktree_remove({ target: "<path|branch|workspace-id>", preserve: true })` or `/worktree remove <target> [--preserve]`. Preservation is optional and never implied: dirty work is blocked unless explicitly committed first or preserved as a WIP commit. The result reports its SHA even if removal later fails or is refused. A failed preservation commit restores the pre-preservation index and never proceeds to removal. Inventory and removal reports disclose exact ignored-file counts: enumeration is streamed rather than buffered as one listing. Ignored files do not block cleanup and are not captured by preservation; failed counting still blocks removal.

Eligibility is rechecked at removal time: canonical source-repository cwd containment, registered linked checkout, no detected process holder, known live child, or persistent lease, and clean Git state with no untracked files or conflicts. A successful launch from a linked checkout does not itself authorize its removal; cleanup uses the canonical principal/source repository under the invoking parent session's cwd, not `manifest.sourceCwd` or shared Git identity. Start the parent Pi session rooted at that principal checkout or an ancestor containing it, then use normal explicit cleanup; `cd` inside an existing Pi session does not change the session cwd. Unknown inspection, identity disagreements, detached HEAD, locked checkouts, and initialized submodules block removal. Out-of-scope repositories are never eligible. Open workspaces use Herdr removal; orphans use Git removal and registration pruning after checkout absence is verified. Owned reachable manifests are marked `removed`; manifests from other sessions are not required or rewritten. Stale removed manifests never govern a recreated checkout. Missing or dangling manifest paths do not affect unrelated checkouts; undecidable or conflicting manifest identity still blocks removal. A failed manifest update after removal is reported as a warning. Symlinked ancestors are supported; checkout symlinks escaping the canonical managed root are blocked. Process inspection covers observable same-user processes across sessions, regardless of runtime name, exempting only Herdr-confirmed idle retained shells, never runtimes at the same PID. Unreadable individual process details produce non-blocking warnings without an override flag; scanning continues so another observable holder still blocks removal. Human and structured inventory/removal results disclose incomplete coverage, including warnings seen before a later recheck or failure. Same-user inspection is permission-limited, and other-user processes are not inspected: a protected process could hold the checkout undetected. Warnings aggregate counts and bounded PID samples, not commands or environments. Linux uses `/proc`; macOS uses same-user `lsof` cwd records and warns for unreadable individual records. Unsupported platforms, failed global enumeration (including a failed `lsof` with partial output), and other unverifiable eligibility evidence still block removal. Cleanup Git and Herdr calls have 30-second timeouts.

Cleanup never deletes or rewrites branches, uses force flags, or runs automatically. Session startup does not scan worktree inventory, avoiding blocking Pi initialization; use `/worktree list` or `worktree_list` for an explicit inventory. Child sessions retain `/worktree list` and `/worktree <name>`, but receive neither cleanup tools nor the remove subcommand. Their repository-local listing labels detached entries `(detached HEAD)`; a detached sibling does not prevent inspection of named branches. See [cleanup and recovery](docs/worktree-subagents.md#cleanup) for details.

## Custom Agents

Custom agent roles are the package's primary extension mechanism. Create one
when a child needs a reusable, bounded responsibility such as scouting,
implementation, or review. If the new concept instead describes a multi-stage
user outcome, make it a workflow, command, or Pi skill that composes roles; do
not disguise a workflow as an agent definition.

### 1. Choose the scope

| Scope | Location | Use when |
| ----- | -------- | -------- |
| Project | `.pi/agents/<name>.md` | The role belongs to one repository |
| Global | `$PI_CODING_AGENT_DIR/agents/<name>.md` | The role should be available everywhere; the default root is `~/.pi/agent` |
| Role pack | An installed Pi package's registered `roles/` directory | The role should be independently installable and shareable |
| Bundled | This package's `agents/<name>.md` | Contributing a fallback role maintained with `pi-herdr-agents` |

The filename stem is the launch key. `name` frontmatter is optional because it
defaults to the filename stem. If supplied, keep it identical so overrides remain
predictable; role packs reject mismatches.

### 2. Create the definition

```markdown
---
description: Reviews a bounded change for concrete security vulnerabilities
thinking: high
tools: read, bash
system-prompt: append
session-mode: standalone
spawning: false
auto-exit: true
---

# Security Reviewer

Review only the requested change. Trace trust boundaries and affected callers.
Report concrete findings with file and line references, exploit conditions,
severity, and the smallest safe correction. Do not modify files.
```

Omit `model` to use `models.agents.<name>`, then `models.default`, then the
parent model. Put `model` in frontmatter only when the role itself needs a
specific exact authenticated `provider/model-id`.

`tools` is passed to Pi's `--tools` allowlist and may name any registered
built-in, extension, or custom tool. Listing a tool does not install its
extension. Use one non-empty inline comma-separated scalar, such as
`tools: read, grep`; do not use YAML lists, containers, quotes, or comments.
Omitting `tools` intentionally leaves the role unrestricted. Likewise, `skills`
names must already be discoverable by Pi; this package does not install role
prerequisites.

### 3. Verify and launch

```text
/subagent list
/subagent security-reviewer Review the authentication changes against main
```

Or call the tool directly:

```typescript
subagent({
  name: "Security review",
  agent: "security-reviewer",
  task: "Review the authentication changes against main.",
});
```

Agent files are read when definitions are listed or launched, so creating or
editing one normally does not require `/reload`. Installing, removing, updating,
or changing the extension code of a role pack uses Pi's normal `/reload` flow.

### Publish a role pack

A role pack is an ordinary Pi package with Markdown definitions and a tiny
extension that registers their directory through Pi's public inter-extension
event bus:

```text
security-roles/
├── package.json
├── extension.ts
└── roles/
    └── security-reviewer.md
```

```json
{
  "name": "@acme/security-roles",
  "version": "1.0.0",
  "keywords": ["pi-package"],
  "type": "module",
  "pi": {
    "extensions": ["./extension.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

```typescript
import { fileURLToPath } from "node:url";

const roles = fileURLToPath(new URL("./roles", import.meta.url));

export default (pi: any) => {
  const unsubscribe = pi.events.on(
    "pi-herdr-subagents:roles:discover:v1",  // stable protocol identifier
    (request: { apiVersion: number; register(path: string): void }) => {
      if (request.apiVersion === 1) request.register(roles);
    },
  );
  pi.on("session_shutdown", unsubscribe);
};
```

Install both packages through Pi; the role pack remains inert if
`pi-herdr-agents` is absent:

```bash
pi install git:github.com/zhengfran/pi-herdr-agents
pi install npm:@acme/security-roles
```

Registration is synchronous and accepts one absolute Markdown file or a
directory whose direct `.md` children are roles. The bridge must unsubscribe on
`session_shutdown` as shown so removed or updated packages do not survive a
reload. A copyable package lives in [`examples/role-pack/`](examples/role-pack/).
The host reads and validates
the files, derives package name/version from the nearest `package.json`, and
reports invalid paths, missing descriptions, filename/name mismatches, and
package-layer collisions in the listing surfaces.

Role packs cannot replace an enabled bundled role, and duplicate role names
from multiple role packs are disabled rather than resolved by extension load
order. Use a global or project definition for an intentional override.

See [ADR-0003](docs/adr/0003-installable-role-packs.md) for the registration seam,
collision rules, and rejected alternatives.

### Authoring checklist

- The role has one bounded responsibility and a clear report or handoff contract.
- The filename stem is the role name; if `name` is present, it matches the stem.
- `description` states the role's input/output responsibility.
- `tools` and `skills` contain only installed, necessary capabilities.
- Leaf roles set `spawning: false`.
- Autonomous roles set `auto-exit: true`; interactive roles leave it off.
- Generic roles omit `model` unless a particular runtime is functionally required.
- `/subagent list` shows the expected source and a smoke launch succeeds.

Capability declarations are strict: use the unquoted, unindented keys
`tools:`, `deny-tools:`, `spawn-agents:`, and `spawning:` exactly once when present. Declare
`tools`, `deny-tools`, and `spawn-agents` as non-empty inline comma-separated scalars, and
`spawning` as exactly `true` or `false`. YAML lists, containers, multiline
values, quotes, comments, empty values, duplicates, noncanonical key spelling,
and invalid booleans are rejected. A role with an invalid capability declaration
is excluded from discovery, and an exact-name launch reports the diagnostic
before creating a Herdr pane or worktree. Other unsupported or unknown
frontmatter may still be ignored.
Compare definitions against the reference below and verify them with
`/subagent list` plus a smoke launch.

### Frontmatter Reference

| Field         | Type    | Description                                                                                                                                                                                                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string  | Optional explicit agent name used in `agent: "my-agent"`; defaults to the filename stem and must match it in role packs                                                                                                                                                                                            |
| `description` | string  | Shown in `subagents_list` output                                                                                                                                                                                                                                            |
| `model`       | string  | Optional exact authenticated Pi model default or ordered comma-separated fallback list; omit to use per-agent config, global config, then the parent                                                                                                                       |
| `thinking`    | string  | Optional Pi thinking default (`off` through `max`); omit to inherit the parent                                                                                                                                   |
| `system-prompt` | string | `append` passes the agent body through Pi's appended system prompt; `replace` replaces Pi's default system prompt. Without this field, the body is included in the task wrapper                                                                                                                                                                                                                                 |
| `tools`       | string  | One non-empty inline comma-separated Pi `--tools` allowlist under the exact unquoted key `tools:`; may contain any registered built-in, extension, or custom tool name. Omit to leave unrestricted. YAML lists, containers, multiline values, quotes, comments, noncanonical keys, and duplicates are rejected. |
| `skills`      | string  | Comma-separated installed skill names to auto-load. Use this plural form for new definitions; legacy project/global definitions using singular `skill` remain compatible. |
| `session-mode` | string | Default child-session mode: `standalone`, `lineage-only`, or `fork` |
| `spawning`    | boolean | Set exactly `false` to deny all subagent-spawning tools under the exact unquoted key `spawning:`. Only one `true` or `false` declaration is accepted. |
| `deny-tools`  | string  | One non-empty inline comma-separated `pi-herdr-agents` tool list to suppress under the exact unquoted key `deny-tools:`; this is not a universal cross-extension deny list. YAML lists, containers, multiline values, quotes, comments, noncanonical keys, and duplicates are rejected. |
| `auto-exit`   | boolean | Auto-shutdown after Pi fully settles when the latest assistant turn does not end with `stopReason: "aborted"` — no `subagent_done` call needed. User input does not permanently disable auto-exit. Recommended for autonomous agents (scout, worker); not for interactive ones (planner). Also determines the default value of `interactive` (see below). |
| `interactive` | boolean | Override whether stall/recovery transitions wake the parent session. Defaults to the inverse of `auto-exit`: autonomous agents (`auto-exit: true`) are non-interactive and get stall pings; agents without `auto-exit` are interactive and stay quiet. Explicit values take precedence. |
| `persistent` | boolean | Keep this role's specialist session open between tasks. Follow-up work uses `subagent_send`; persistent specialists cannot be resumed in v1. |
| `cwd`         | string  | Default working directory. Absolute paths are unambiguous; relative agent-frontmatter paths resolve from Pi's agent config directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`), not the project root                                                                                                                                                                                                            |
| `disable-model-invocation` | boolean | Hide a role from discovery surfaces like `subagents_list`. The definition remains directly invocable by exact name via `subagent({ agent: "name", ... })`. |
| `cli`         | string  | Optional native harness: `claude` or `kiro`. Omit for Pi-backed roles. Other values fail closed. It is the role's default harness; a spawn's `harness` can select another one. See [Native Claude Code and Kiro roles](#native-claude-code-and-kiro-roles) and [Spawn-time harness selection](#spawn-time-harness-selection). |
| `spawn-agents` | string | Native roles only: one inline comma-separated allowlist of roles the native child may delegate to through its owned bridge (see [Nested delegation](#nested-delegation)). Pi-backed roles declaring it are rejected. |

---

Discovery still resolves precedence before visibility filtering. If a project-local hidden agent has the same name as a visible global or bundled agent, the hidden project agent wins and the lower-precedence agent does not appear in `subagents_list`.

### `session-mode`

Choose how a subagent session starts:

- `standalone` — default fresh session with no lineage link to the caller
- `lineage-only` — fresh blank child session with `parentSession` linkage, but no copied turns from the caller
- `fork` — linked child session seeded with the caller's prior conversation context

`lineage-only` is useful when you want session discovery and fork lineage UX to show the relationship later, but you do **not** want the child to inherit the parent's turns.

`fork: true` on the tool call forces `fork` mode; `fork: false` forces `standalone` mode. Omitting `fork` inherits the agent's frontmatter `session-mode`. `/iterate` uses the explicit `true` override on purpose.

```yaml
---
name: planner
session-mode: lineage-only
---
```

### `auto-exit`

When set to `true`, the agent session shuts down on Pi's `agent_settled` event unless the latest assistant message has `stopReason: "aborted"` — no explicit `subagent_done` call is needed.

**Behavior:**

- Low-level `agent_end` events do not close the session because Pi may still retry, compact and retry, or process a queued continuation.
- After `agent_settled`, a normal or error stop exits, while an aborted stop stays open.
- User input does not permanently disable auto-exit; the latest settled assistant stop reason determines whether the session exits.
- The modeHint injected into the agent's task is adjusted accordingly: autonomous agents see "Complete your task autonomously." rather than instructions to call `subagent_done`

**When to use:**

- ✅ Autonomous agents (scout, worker, reviewer) that run to completion
- ❌ Interactive agents (planner, iterate) where the user drives the session

```yaml
---
name: scout
auto-exit: true
---
```

### `interactive`

Controls whether status transitions (`stalled`, `recovered`) wake the parent session with a steer message.

**Default:** the inverse of `auto-exit`. Autonomous agents (`auto-exit: true`) are non-interactive and ping the parent on stall/recovery; named agents without `auto-exit` are interactive and stay quiet. Bare spawns have no agent definition and default to autonomous auto-exit behavior. `/iterate` is interactive because it explicitly passes `interactive: true`.

**Why it exists:** Interactive agents can run for minutes or hours while the user thinks, types, and reads in the subagent's pane. Child snapshots still update the widget, but stalled/recovered supervision messages rarely need to wake the parent for user-driven sessions. Skipping the steer keeps the parent quiet until the child actually finishes.

**When to override:**

- Set `interactive: false` on an agent that doesn't auto-exit but you still want stall pings for
- Set `interactive: true` on an autonomous agent you'd rather check on yourself

```yaml
---
name: planner
# interactive defaults to true because auto-exit is not set
---
```

Or per spawn:

```typescript
subagent({ name: "Scout", agent: "scout", interactive: true, task: "..." });
```

---

## Native Claude Code and Kiro roles

A role with `cli: claude` or `cli: kiro` runs the native interactive Claude Code
TUI or Kiro CLI 2.24.x V2 (`kiro-cli chat --v2`) instead of Pi. Herdr placement,
managed worktrees, the widget, and the bounded `subagent_result` delivery are
shared with Pi-backed children. Every orchestrator prompt is a *tagged turn*
settled only by its own correlated native hook receipt; terminal text and Herdr
status never establish success. [ADR-0013](docs/adr/0013-native-harness-second-stage.md)
records the design.

```markdown
---
description: Coding worker in native Claude Code
cli: claude
auto-exit: true
tools: read, grep, find, write, edit, bash
thinking: high
system-prompt: append
---

You are a worker agent. ...
```

- An explicit `tools` allowlist is required. Tools map strictly: Claude
  `read→Read`, `write→Write`, `edit→Edit`, `bash→Bash`, `grep→Grep`,
  `find`/`ls→Glob` (`ls` requires `find`); Kiro `read`/`ls→fs_read`,
  `write`+`edit→fs_write` (both required), `bash→execute_bash`, `grep`,
  `find→glob`. Any other tool fails closed. Approval prompts are bypassed only
  for this mapped set. Claude loads no MCP servers except the owned delegation
  bridge (`--strict-mcp-config`); the Kiro profile sets `includeMcpJson: false`
  and lists only that bridge, if any.
- `model` is a native CLI model ID, an ordered comma-separated native list, or
  `task:<category>` from `models.native.<cli>.tasks` (see
  [Native models and fallback](#native-models-and-fallback)). Pi model config
  and Pi provider/model refs never apply. `thinking` maps to `--effort` and
  accepts `low`, `medium`, `high`, `xhigh`, or `max`; omit it for the native
  default.
- Claude uses the role body through `--append-system-prompt` or
  `--system-prompt` when `system-prompt` is set, otherwise in the first turn.
  Kiro always places it in the owned profile prompt; `system-prompt: replace`
  is rejected.
- Prerequisites: `claude` or `kiro-cli` 2.24.x on `PATH`, and `python3`
  (the lifecycle hooks use `fcntl`; the delegation bridge is a stdio MCP
  server in Python).

### Spawn-time harness selection

A spawn can run a named role on a harness other than the one it declares:

```typescript
subagent({ name: "Claude scout", agent: "scout", harness: "claude", model: "sonnet", task: "Map the flow" });
subagent({ name: "Pi reviewer", agent: "native-reviewer", harness: "pi", model: "<provider>/<model-id>", task: "Review the diff" });
```

```text
/subagent <role> [--harness pi|claude|kiro] [--model <value>] [--thinking <level>] [--] [task]
/subagent scout --harness kiro --model "kiro-a, kiro-b" --thinking high -- --literal task text
```

The effective harness is the explicit `harness`, else the role's `cli`, else
`pi`. `harness` requires a named `agent`, and an unresolved role fails before
any resource. Omitting `harness` keeps every existing path unchanged: Pi roles
run on Pi and `cli: claude|kiro` roles run natively, with the same models,
acknowledgement text, and results as before.

Selecting another harness is a **validated role projection**, not a
conversion. The role's tools, thinking, skills, prompt mode, mode, session mode,
and body are interpreted under the destination harness's rules, and anything
that harness cannot represent faithfully fails before Herdr creates a pane or
worktree. Nothing is silently dropped, mapped, or widened:

- Pi → native uses every native rule above: an explicit mappable `tools`
  allowlist without Pi orchestration tools, a native thinking level, installed
  portable skills, no `system-prompt: replace` on Kiro, and no `spawning: true`
  without `spawn-agents`.
- Native → Pi rejects `spawn-agents`: native nested delegation has no
  equivalent bounded Pi policy. Otherwise the role's explicit `tools` allowlist
  bounds the Pi child as usual.
- A frontmatter `model` belongs to the role's own harness. When the role runs
  elsewhere, the pinned model is dropped and an explicit destination `model` is
  required for manual launches; [automatic routing](#automatic-input-routing)
  instead requires a verified administrator-authorized exact destination tuple.
  The pin is never reused, translated, or used as a fallback. Pi → native
  and native → Pi are switches, and so are Claude → Kiro and Kiro → Claude.
- Model namespaces never cross. On Pi, `model` is an exact authenticated
  `provider/model-id`, fallback list, or `task:<category>` from
  `models.tasks`, and a model-less role uses `models.agents`, `models.default`,
  then the parent model. On a native harness it is native CLI model IDs or
  `task:<category>` from `models.native.<cli>.tasks`; Pi provider/model refs
  are rejected, and Pi defaults (`models.default`, `models.agents`, the parent
  model) never apply, so a model-less role uses the native CLI default.
- Fallback stays within the selected harness. There is no cross-harness
  fallback: a failed native attempt never retries on Pi, or the reverse.

Write portable custom roles by declaring an explicit, strictly mappable
`tools` allowlist, omitting `model` (choose it per spawn), and using thinking
levels from `low` through `max`. A role that pins `model`, uses `spawn-agents`,
or depends on Pi-only tools remains bound to its own harness. Role discovery,
precedence, hidden roles, and diagnostics are unchanged: the harness applies to
the definition that exact-name lookup resolves.

The role is resolved and projected once per spawn. The acknowledgement,
completion and error, help-request, persistent task-result, and persistent
stop, stop-failure, and crash notice details carry a `selection` record:

```json
{
  "harness": "claude",
  "harnessSource": "request",
  "projected": true,
  "role": { "name": "scout", "source": "project", "harness": "pi" }
}
```

`harnessSource` is `request`, `role`, or `default` for manual launches, and
`auto` for an administrator-authorized automatic selection; `role.source` is
`project`, `global`, or `package`, with `provider` and `providerVersion` for
role packs. Selected models and thinking stay in the existing fields
(`runtimePlan` for Pi; `model`, `nativeModels`, `nativeThinking`, and
`native.model` for native runs). Every fallback attempt and persistent session
generation keeps the same selection and role snapshot, even if the role file
changes. An explicit `harness` also adds a `Harness:` line to the
acknowledgement text. Resume never re-resolves the role or harness: a native
marker replays its recorded loadout (including its harness) even if the role
changed or no longer exists, and resumed runs carry no `selection`.

`/subagent` options precede the task. A value is one word, or a quoted
string; single quotes are literal, and double quotes accept only `\"` and `\\`
escapes. Quote a fallback list that contains spaces. Empty, unclosed, missing,
duplicate, and unknown options, and invalid harness or thinking values, are
rejected without dispatching. Task text starts at the first word that does not
begin with `--`, or after a lone `--`, and is kept verbatim, including quotes,
backslashes, tabs, newlines, and later `--`. `/subagent <role>` without a task
still asks the role to wait for instructions.

### Native modes

| Mode | Role frontmatter | Behavior |
| --- | --- | --- |
| Autonomous | `auto-exit: true` | After the last tagged turn's correlated `Stop`, the parent types `/exit` (Claude) or `/quit` (Kiro). Human input fails the run closed. |
| Interactive | no `auto-exit` | The parent never types an exit command. A human may type in the pane; human-driven turns are counted and disclosed in the result, never presented as the orchestrator's result. The result is delivered once, when the human quits. It succeeds only if every tagged turn completed. Stall notices do not wake the parent. |
| Persistent | `persistent: true` | A [persistent specialist](#persistent-specialists) with native tasks. Human input fails closed. |

Parent input (follow-ups, tasks, nested results, exit commands) is typed only at
a *verified idle point*: the latest tagged turn's correlated `Stop`/`StopFailure`
receipt, or in interactive sessions a completed human-driven turn. It is never
typed while a typed turn awaits acknowledgement, and never into a busy TUI or a
dialog. Typed text is flattened to one line of at most 8 KiB with terminal
control characters removed. A typed turn not acknowledged within 30 seconds is
never retyped. Autonomous and persistent runs fail closed. An interactive
session records the turn as `unacknowledged` (a human may have been typing)
and suspends further parent input.

### Follow-ups

`subagent_send({ id|name, message })` to a running non-persistent native child
queues one follow-up (at most 4 pending) and returns `queued`. It is typed as a
new tagged turn at the next verified idle point, exactly once. The final result
lists every tagged turn and its outcome (`completed`, `failed`, `interrupted`,
`superseded`, `unacknowledged`, `not-delivered`), and its summary is the last
completed turn's. An autonomous run that ends a turn in failure types no queued
follow-up; those are `not-delivered`. Pi-backed non-persistent children still
reject `subagent_send`.

### Native resume

Every fresh native run writes a v2 marker with its complete loadout and a
SHA-256 integrity hash. The loadout covers tools and their native mapping,
model, thinking, prompt mode, role-identity hash (identity text in a 0600
file), mode, session mode, skills, nested-spawn allowlist, Kiro agent name,
lineage, and worktree binding.
`subagent_resume({ sessionPath: <marker>, message, name? })` replays exactly
that loadout, including its recorded mode: it never reads the current role and
cannot widen or narrow anything. An `autoExit` that disagrees with the recorded
mode (for example `autoExit: false` for an autonomous session) is rejected
before launch; one that restates it is accepted. Claude reopens
the same UUID with `--resume`. Kiro exclusively recreates the saved agent
profile name and passes `--resume-id`. Hooks fail the run closed if the native
session identity changes.

An exclusive session lease (`<marker>.lease`) binds a session to the one run
driving it. Leases are durable files naming the run's receipt and owner token,
so any later parent process can check them. A lease is released only after
that run's exit is confirmed, including every owned descendant process. A
second resume, including one from another parent process after a crash, is
refused while an owned process may still run. A stale lease is reclaimed only
with confirmed exit evidence. Refused resumes launch nothing. They include
tampered or v1 markers, a changed skill snapshot or role identity file,
persistent specialists, missing native identity, unconfirmed exits, a mode
change, and a missing working directory. The role identity text is read once
at launch and must match its recorded hash, so the text that launches is
exactly the text verified.

A native run in a managed worktree also holds a durable worktree lease
(`<manifest>.native-lease`) for its lifetime. The lease also records a
reservation by the launching parent (PID, kernel start time, and a random
token). While that exact parent lives, the lease stays held even between
fallback attempts. Once the parent is provably gone, only the run's own exit
evidence matters. Without `/proc` the parent's identity cannot be proven, so
a live reservation stays held (fail closed). A worktree-bound session resumes
in a new ordinary pane at the retained worktree. It requires the same path,
branch, and workspace, a manifest not marked removed, no live or unconfirmed
in-memory holder, and no durable worktree lease whose run may still be alive
(for example one left by a crashed parent). It holds the worktree lease until
its exit is confirmed. Git state is reported again on completion and the
manifest is updated. The workspace itself is never recreated, moved, or
removed.

### Fork and lineage

`session-mode: lineage-only` records the parent session in the loadout and
transfers no turns. `fork` (or `fork: true`) transfers a bounded (32 KiB) text
rendering of the parent's compaction-aware active branch, up to but excluding
the user turn that requested the child. It includes user and assistant text,
compaction and branch summaries, and tool-call names. Tool results, tool
arguments, hidden reasoning, and images are omitted; when the bound is
exceeded, the oldest messages are dropped and counted. The rendering is placed
in the first tagged turn inside an unguessable boundary marked as untrusted
reference data, and recorded as a 0600 `inherited-context.md` artifact whose
hash is in the loadout. No native history is fabricated.

### Skills

`skills` names installed Pi skills (from the parent's skill discovery). Each is
embedded in the first turn as a Pi-format `<skill>` block. A skill with
supporting files is first copied into a private, content-addressed snapshot
(`artifacts/<session-id>/native-skills/<sha256>/`, read-only files). The
block then points only at that snapshot, never at the live installation. The
snapshot hash is bound into the loadout. Resume fails closed, both when it is
requested and again immediately before launch, if the snapshot no longer holds
exactly those bytes. It also fails closed if the snapshot or its root is a
symbolic link or not a real directory, lies outside the session's own artifact
directory, or holds a symbolic link, hard link, or special file at any depth.
Files are read without following links. Every directory and file read is
pinned by inode, metadata, and content, and all of them are rechecked after the
walk, so replacing or editing any nested entry during verification fails
closed. Later edits to the installed skill never reach the resumed session. A
skill is rejected before launch, never truncated, when:

- it exceeds 24 KiB (48 KiB total) or declares `allowed-tools`/`tools` the
  role lacks;
- its supporting files exceed 256 KiB (512 KiB total), 200 files, or 4 levels;
- it contains symbolic links or special files;
- it has supporting files and the role lacks `read`, or ships scripts and the
  role lacks `bash`.

Instructions that assume Pi-only tools (for example `subagent` or
`caller_ping`) cannot be detected; those tools do not exist natively.

### Native models and fallback

Candidates are ordered native model IDs; `null` (no `model`) means the CLI
default. Values that name a model in Pi's provider/model registry are rejected.
A later candidate is tried only with positive evidence that the failed attempt
did no task work. Its exit must be confirmed, including every owned
descendant. The run's own correlated session-start hook receipt must prove
its hooks were active, with no prompt-submit receipt, human turn, or hook
error ever recorded.

These are never retried, because the turn started or nothing proves it did
not:

- a completed result, even a negative one;
- a correlated Claude `StopFailure` (it follows an active turn that may have
  used tools);
- an interrupted or superseded turn;
- an exit after the prompt was submitted;
- an exit before any hook receipt.

Persistent specialists use only the first candidate. A managed worktree is
reused for the next attempt, in its retained root pane, only under the same
evidence and when the checkout is verifiably pristine (clean, no untracked
files, head at the base). The durable worktree lease is never absent between
attempts. The launching parent reserves it, and it is handed from each attempt
to the next by an atomic replace. It is released only after the final
attempt's exit is confirmed. A parent shutdown between attempts, or while an
attempt waits for its shell, launches no further process. If a later
attempt's watcher fails, that attempt's own exit is re-checked before its
leases are released. If a later attempt fails after dispatch with an
unconfirmed exit, the result is about that attempt: its marker, session,
model, and pane are primary and recovery targets it, while earlier attempts
appear only in the history. Results list `Models attempted` and raw
per-attempt errors with each attempt's marker.

### Nested delegation

A native role may delegate only through an explicit allowlist:

```yaml
spawn-agents: scout, reviewer
```

`spawning: true` without `spawn-agents` is rejected, as are Pi orchestration
tools in `tools`. The child receives one owned stdio MCP server (`pi-subagents`)
with a single `subagent` tool (`agent`, `name`, `task`). Each call writes an
HMAC-signed request into the run's private directory. The parent atomically
claims it and verifies the run, nonce freshness, age, and that the sender PID
carries the run's owner token. It then launches the role only when it is on
the allowlist, has an explicit `tools` allowlist within the requester's own
tools, is `auto-exit: true`, and is not persistent. The launch is a standalone
ordinary-pane leaf in the requester's cwd with every spawning tool denied.
Limits are 4 concurrent and 16 total per run. The nested result
returns to the requester as one correlated follow-up turn marked as untrusted
data; an autonomous requester does not exit while results are owed. If the
requester has ended, the parent receives the result instead. Delegation needs
Linux `/proc` and is not available to persistent specialists. The bridge
resists stale, replayed, misdirected, and sibling requests, but not a malicious
same-user process that reads the run's 0600 files.

### Still rejected

Rejected before any pane, workspace, or worktree is created: Pi child tools
(`caller_ping`, `subagent_done`) and Pi orchestration tools in `tools`;
unmappable tools; `cli-model`; unknown `cli` values; unsupported thinking
levels; `system-prompt: replace` for Kiro; `spawning: true` without
`spawn-agents`; delegation by persistent specialists or without `/proc`;
unknown task categories or missing native candidates; Pi provider/model refs;
uninstalled or non-portable skills; fork without a persisted parent session;
and initial prompts over 120 KiB. `deny-tools` has no effect because the native
tool set is exactly the mapped allowlist. Spawn-time harness selection adds:
`harness` without `agent`; an unresolved role; switching a role with a pinned
`model` without an explicit destination model; and a role with `spawn-agents`
projected to Pi.

### Receipts, ownership, and cleanup

Each launch owns exclusively created per-run files under the parent session's
`artifacts/<session-id>/native-runs/<id>/`: hook configuration, correlated turn
state, a durable process receipt written by the launch wrapper, and, when
delegation is granted, the bridge configuration and request directories.
Completion requires every tagged turn's native-session-correlated receipt plus
a clean process exit after the graceful exit command (autonomous) or the
human's exit (interactive). Untagged input in a non-interactive run, a hook
error, an acknowledgement timeout, or an exit without the correlated receipt
fails closed. The parent then terminates only processes it can prove it owns
and reports the failure. Results cite the native session ID, the turn outcomes,
and the `artifacts/<session-id>/native-sessions/<id>.json` marker in place of a
Pi transcript.

Process ownership is bound to an unguessable per-run token, not a PID. The
launch wrapper re-executes itself with the token in its environment, records it
in its receipt, and refuses to start without it or after the parent writes a
cancel marker. On Linux the parent reads `/proc/<pid>/environ` and signals only
processes carrying the token (the wrapper's process group only after the
wrapper itself is verified); a reused PID is never signalled. Where ownership
cannot be verified (for example macOS, or an unreadable process), nothing is
signalled. Same-user processes whose environment is unreadable are disclosed as
incomplete scan coverage, following the worktree cleanup visibility policy.

Owned files are removed, leases released, and worktree Git state captured only
after process exit is confirmed. Confirmation means either the wrapper recorded
its exit and no owned descendant carrying the token survives, or a complete
owned-process scan found nothing. In both cases, no same-user process related
to the run may remain unproven. A related process is a descendant of an owned
process, or a member of the wrapper's process group, which orphaned
descendants keep. It is unproven when its environment is unreadable or lacks
the token (for example a scrubbed environment). Unreadable unrelated processes
are only disclosed. A descendant that outlives the CLI (for example a
background command a tool started) is given a short grace period, then keeps
the run unresolved; it is never signalled on a normal exit. A wrapper's exit
receipt alone never confirms exit.

Otherwise the result reports `processExit: "unconfirmed"` with a warning and
the run is treated as failed. This covers termination refused or not observed
within the grace period, a lost receipt with survivors, live descendants,
parent shutdown while the child runs, and a launch that fails after its script
was dispatched. Its pane, Kiro profile, native run files, session and worktree
leases, and worktree are retained. The worktree manifest records
`processExit: "unconfirmed"` without a Git snapshot. `worktree_remove` treats
the worktree as held, through the in-memory holder and the durable native
lease, until exit is later confirmed; then the owned files and leases are
released. After the parent accepts the result of an autonomous, non-persistent,
non-nested run, it re-checks exit in the background with backoff (2 to 60
seconds). It closes that run's ordinary pane once, after exit is confirmed.
If a re-check released the run before the result was accepted, the pane closes
once at acceptance, after a fresh check confirms that exit again. A failed
watcher whose exit a fresh check confirms closes its ordinary pane after its
error result is accepted. Interactive, persistent, nested, worktree,
suppressed and rejected (failed parent send) runs keep their panes. The
re-check lives in the parent process: it survives `/reload` but not a parent
restart, and panes retained before a restart need manual cleanup. Parent
shutdown does not terminate native children. Launch scripts
embed task text and are staged `0600` in `0700` directories created for them.
A parent shutdown or a cancelled `subagent`/`subagent_resume` call, while a
native launch still waits for its shell, stops the launch before its process
is dispatched. The never-started run's files and leases, and a pane that launch
created, are then released; a managed worktree is retained and marked failed.

Linux scans `/proc` (environments, parent PIDs, and process groups). macOS
lists same-user processes with their parent PID, process group, and
environment (`ps -E`). It trusts the listing only when it shows this parent's
own environment. Any process whose command or environment carries the owner
token, and any unproven related process, keeps the run unresolved. A listed
process with an unknown parent or group and an unreadable environment counts
as related. That listing only proves processes present or absent and never
authorizes a signal, so macOS never signals native processes. Where `ps` does
not show environments, no native exit can be confirmed: every native run stays
unresolved, and its leases and worktree stay held. On either platform, a
descendant that leaves both the run's process tree and its process group (for
example with `setsid`) and also hides or scrubs its environment cannot be
detected.

A persistent specialist's settled task is delivered to the parent exactly
once. Every settlement is queued once per task ID before any delivery attempt,
including a `Stop` written just before the CLI exits, which the final outcome
settles. It is also appended to a private `<marker>.settled.jsonl` record.
Delivery sends only tasks this parent settled from correlated receipts and
never reads that record, so a line another process writes there is never
delivered. If the parent send fails (for example across `/reload`), the task
stays owed and the specialist stays busy (`rejected-busy`) until a retry
succeeds. The durable delivery ledger and an in-memory record prevent
duplicates. An unreadable ledger proves nothing, so owed results stay pending
and retryable, and the in-memory record still prevents duplicates. A task
whose dispatch cannot be recorded is withdrawn before it is typed, and
`subagent_send` reports that nothing was dispatched. After the process ends,
owed results are retried for up to two minutes before the stop or exit notice
is sent; any still undelivered are included in that notice. A notice that
fails to send is retried until the same deadline. A specialist that exits
without a stop request is reported as having exited, with the number of results
delivered before the notice and the reason the run ended.

A native specialist's first task is recorded before its process exists. The
ledger is checked for writability before any pane, worktree, or run is
created, so an unwritable ledger launches nothing. A `planned` record is
written just before the process is dispatched and is committed as
`dispatched` right after. A launch that fails before dispatch is recorded as
`abandoned`, so it never appears as an active task. If the commit itself
fails, the live specialist is still registered and supervised and the
acknowledgement carries a warning; it is never left untracked. A plan left
behind by a parent crash is resolved at the next session start. The run's
cancel marker is written first, so a wrapper that has not started can never
start its CLI. A run without a start receipt is then `abandoned`, and one
with a receipt is `dispatched`. Launches still in flight, unresolved, or
supervised in the current process, including across `/reload`, are never
touched. A Pi-backed specialist whose first dispatch cannot be recorded is
likewise kept supervised, with a warning.

Kiro receives a transient `.kiro/agents/pi-subagent-<uuid>.json` profile in the
child's working directory (the worktree root for worktree runs). It is created
exclusively, never overwrites existing configuration, lists only regular
`AGENTS.md`/`CLAUDE.md` files in that directory as resources, and is removed
after the run only while its content is unchanged; directories are removed only
when this run created them and they are empty. The profile is removed before
worktree state is captured, so it does not appear as an untracked handoff file.
A resume recreates the same profile name; if a modified profile with that name
was retained, the resume fails closed.

Limitations: Claude Code may show a first-run workspace-trust dialog for a new
directory, including a new worktree; the parent never answers it, and the run
fails after 120 seconds without acknowledgement. Native session persistence
depends on the CLI: an interrupted autonomous run is usually ended by verified
termination (Claude fires no hook for a user interrupt), so its resume depends
on what the CLI saved. The interrupt key is Escape for both CLIs; if Kiro
ignores it, the turn keeps running but is still recorded as interrupted, and an
autonomous run is terminated after the grace period. Kiro V3 is unsupported.

## Tool Access Control

Without a restrictive `tools` allowlist or spawning policy, a sub-agent can spawn further sub-agents. Control this with frontmatter. Native `cli: claude|kiro` roles never receive Pi tools; they delegate only through an explicit `spawn-agents` allowlist, within their own tool ceiling (see [Nested delegation](#nested-delegation)):

### `spawning: false`

Denies all subagent lifecycle tools (`subagent`, `subagent_interrupt`, `subagent_send`, `subagent_stop`, `subagents_list`, `subagent_resume`):

```yaml
---
name: worker
spawning: false
---
```

### `deny-tools`

Fine-grained control over tools registered by `pi-herdr-agents`:

```yaml
---
name: focused-agent
deny-tools: subagent
---
```

### Recommended Configuration

| Agent | `spawning` | Rationale |
| --- | --- | --- |
| planner | *(default)* | Can spawn scouts for investigation. |
| poteto | `true` | Delegates independent work. |
| adversarial-reviewer | `true` | Compatibility coordinator; launches bounded discovery, conditional verification, and synthesis children. It sets `auto-exit: false` so automatic child-result steers can drive every wave, then calls `subagent_done`. |
| worker | `false` | Implements bounded tasks. |
| reviewer | `false` | Reviews without delegation. |
| scout | `false` | Gathers context without delegation. |
| visual-tester | `false` | Performs visual QA without delegation. |

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter. Use an absolute path for a project directory; relative frontmatter paths are resolved from Pi's agent config directory:

```yaml
---
name: game-designer
cwd: /absolute/path/to/project/agents/game-designer
spawning: false
---
```

---

## Tools Widget

Every sub-agent session displays a compact one-line tools widget summarizing available and denied tools:

```
[scout] — 12 tools · 4 denied
```

---

## Development

Run local checks:

```bash
npm ci
npm test
npm run test:eval:jev-routing
npm run format:check
npm run lint
npm pack --dry-run
git diff --check
```

Automatic-routing unit/public-handler tests are not real TUI evidence. The
focused offline checks are:

```bash
node --experimental-strip-types --test test/auto-routing-*.test.ts test/jev-client.test.ts test/jev-questions.test.ts
node --experimental-strip-types --test test/evals/jev-routing-*.test.mjs
```

Run the required end-to-end suite from inside Herdr:

```bash
npm run test:integration
```

Run only one integration suite at a time per Herdr instance. The automatic suite
uses real idle editor submission in a persisted TUI session, not a direct handler
or RPC routing proxy; separate real RPC processes verify bypass. Its isolated
Herdr environment uses a fake classifier and offline native executables. Focused
command: `node --experimental-strip-types --test test/integration/auto-routing.test.ts`.
It runs only in deterministic mode (live mode skips it). Pi 0.99.1 idle local
cancel and pre-dispatch `newSession` remain two honest blockers/skips, never
passes; Escape was observed reaching timeout. Record counts and test-owned
resource cleanup using the
[source-checkout contributor integration workflow](https://github.com/zhengfran/pi-herdr-agents/blob/main/.pi/skills/run-integration-tests/SKILL.md)
(the skill is excluded from the installed package).
Do not enable auto routing as part of package/release verification.

The deterministic suite is designed to launch real Pi sessions, Herdr panes,
and worktrees without live providers. That describes the isolated test setup,
not a claim that all historical implementation activity was network-free.
The optional live-provider smoke test is not a merge gate:

```bash
PI_TEST_MODEL="openai-codex/gpt-5.6-luna" PI_TEST_TIMEOUT=180000 \
  npm run test:integration:live
```

See [RELEASING.md](RELEASING.md) for versioning, trusted publication, and release verification.

---

## Acknowledgements

This repository is a fork of [giuseppecrj/pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents); its Herdr-native orchestration, managed worktrees, persistent specialists, role system, and review workflows form the foundation of this fork. Please refer to the upstream project for its original development and release history.

The upstream package builds on earlier open-source work by [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) and [0xRichardH/pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents). The native Claude Code and Kiro harness adapters, lifecycle hooks, and process receipts in this fork are ported from [zhengfran/pi-interactive-subagents](https://github.com/zhengfran/pi-interactive-subagents) (MIT, same upstream lineage). The sub-agent status supervision and turn-only interruption features were inspired by [RepoPrompt](https://repoprompt.com/)'s sub-agent snapshot polling and run cancellation features.

---

## License

MIT. Copyright notice retained from the upstream lineage (`HazAT`).
