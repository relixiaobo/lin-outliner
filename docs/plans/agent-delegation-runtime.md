# Agent Delegation

**Shape:** A SET of complete features. Generic background Tool Tasks ship first
as an independently useful Bash capability. Internal delegation then ships as a
complete replacement for Subagents. Each external Runner is a separate complete
adapter, not part of the foundation PR.

## Goal

Keep the two useful properties of Subagents, parallel execution and fresh
context, while removing Agent trees, nesting, peer messaging, and model-owned
Runner policy.

The root Agent loads the built-in `delegate` Skill and invokes a packaged CLI
through background `bash`. The CLI runs one isolated task and exits with one
result. Delegation always uses the same generic background-task capability as
video generation, builds, exports, and any other long Bash command, so the root
conversation never waits synchronously for an Agent run.

- **OBJ-1:** The user has one root collaborator; delegated work is ordinary tool
  work that the root eventually integrates or takes over.
- **Clean-slate answer:** Bash owns generic process execution, Tool Tasks own
  background lifecycle, the delegation CLI owns one delegated run, and Runners
  own only harness adaptation.
- **Selected brownfield answer:** Reuse the current Agent execution kernel,
  tools, provider adapters, artifacts, worktrees, and Host-started Turns while
  deleting Subagent-specific identity, ledgers, routing, and UI.
- **Minimum acceptable outcome:** The internal Runner fully replaces current
  Subagents, every terminal outcome returns ownership to the root, and the old
  surface is gone.

Delegation is experimental and off by default. External harness discovery is
automatic and read-only; use remains explicitly authorized by the user.

## Non-goals

- No model-visible delegation, Agent, spawn, send, wait, inbox, or roster tool.
  Invocation is `skill` -> `bash` -> `delegate`.
- No addressable child Agent, resumed delegated conversation, generation tree,
  peer messaging, or more than one delegation level.
- No model-selected model, effort, concurrency, local scheduling limit, retry,
  fallback, or worktree policy. A non-default Runner is allowed only to honor an
  explicit Runner named in the current user request.
- No silent retry, model fallback, Runner failover, or replacement task.
- No background system specialized for delegation. The generic layer contains
  no Runner, model, Agent, profile, or delegation field.
- No claim that delegation saves time or cost without complete-workflow evidence.
- No discovery or inference of API keys, accounts, Provider concurrency limits,
  cross-application usage, or credential sharing between Runners.
- No remote A2A service, general workflow engine, or arbitrary shell-template
  adapter.
- No external harness plugins, hooks, user MCP servers, custom Agent packs, or
  background Agents in the first external adapters.
- No migration for pre-release Subagent execution data.

## Design

### Decision summary, constraints, and alternatives

The binding constraints are:

- the model invokes the CLI only through existing Bash;
- the user owns enabled Runners, the default Runner, and model policy; the root
  may select a non-default enabled Runner only when the current user request
  explicitly names it;
- an unavailable explicit model rejects before execution;
- delegation depth is structurally one;
- the root remains responsive and owns final synthesis; and
- Tenon may bound only the work it starts locally; actual Provider and API-key
  concurrency remains unknown until a request succeeds or fails.

Rejected alternatives:

- A model-visible `delegate` tool duplicates Bash background semantics and puts
  changing Runner policy back into a model schema.
- A Delegated Task ledger beside a background Bash ledger creates competing
  completion, cancellation, and notification truth.
- Treating a remote protocol or external harness session as the task makes local
  failure and result recovery depend on vendor semantics.
- Shipping every external harness with the replacement makes the core design
  depend on three unrelated CLIs before its value is known.

### Evidence and assumptions

- Current background Bash ownership is the in-memory `backgroundTasks` map with
  bounded history and temporary output; it has no durable generic completion
  authority. This is the foundation gap, independent of delegation.
- The injected `KernelAgentOptions` boundary in `NativeAgentRuntime` supports a
  headless model gateway and tool set. The internal Runner reuses this kernel;
  it does not copy `PiTurnExecutor` or its Electron-backed Settings/tool wiring.
- Local executable evidence confirms non-interactive entry points for Claude
  Print, Codex Exec, and OpenClaw ACP. Exact flags remain version-bound Adapter
  fixtures, not permanent assumptions in this plan.
- PR #619's real Agent replay is the design precedent for a one-call common
  path, one contract registry, closed-loop receipts, and task-corpus-first CLI
  design.

### Main flow and ownership

```text
root Agent
  -> `delegate` Skill
  -> background bash(command: "delegate run --input - --output json")
       -> generic process supervisor
       -> delegate CLI
            -> internal Tenon Runner
            -> external harness Runner
  -> generic background completion
  -> root synthesis or ownership recovery
```

| Owner | Responsibility |
| --- | --- |
| Bash | Command, stdin, generic foreground/background execution, process sandbox. |
| Tool Task | Background identity, process truth, output, artifacts, cancel, recovery, delivery. |
| `delegate` Skill | When to delegate work to another Agent and how to form task intent. |
| `delegate` CLI | Admission, policy resolution, local scheduling lease, Runner lifecycle, normalized result. |
| Runner | One internal kernel session or external harness process. |
| Root Agent | User communication, verification, integration, and ownership recovery. |

The CLI process and its process group are the delegated run. There is no
app-owned Delegated Task beside it. Internal execution state, external session
IDs, transcripts, and logs are evidence attached to the process result, not
independent task authorities.

### Generic background Tool Tasks

This foundation applies to every background or auto-background Bash command.
Delegation is only its first demanding consumer.

`ToolTaskService` replaces the in-memory background-process map with a durable,
domain-neutral record containing:

- Host task ID, owner Thread, source Turn and Tool Item;
- command digest and display description, never duplicate command text;
- cwd, process identity, start and terminal timestamps;
- execution status and factual exit information;
- bounded stdout/stderr, declared output artifacts, and optional public progress;
- cancellation and timeout facts; and
- root-delivery claim and delivery Turn reference.

Its execution states are:

```text
running -> succeeded | failed | cancelled | timed_out | lost
```

Terminal state and result are immutable. Delivery is separately
`pending | delivering | delivered | blocked`; it never means handled, accepted,
or used.

The Host runs each background command through a generic supervisor wrapper. The
supervisor owns the process group, durable output files, a nonce-bound process
identity, and an atomic terminal receipt. After app restart, the Host reattaches
to a matching live supervisor or reads its receipt. A missing process and
missing receipt becomes `lost` with preserved partial output; it is never
replayed.

Background Bash supports the same bounded `stdin` as foreground Bash. The Host
creates capture and task state first, starts the supervisor, writes and closes
stdin with backpressure, and returns the task handle only after the input was
accepted. Early exit or write failure settles that same task.

Ordinary commands require no integration. Cooperative CLIs may emit bounded
generic progress events such as a phase, message, or producer-supplied fraction.
The service validates and stores them without interpreting domain payloads.
Delegation never invents a percentage or exposes hidden reasoning; a future
video CLI may report a factual render percentage through the same channel.

Tool naming deliberately has two layers. Producer tools keep their domain names,
such as `bash`, and may return a `task_id` when execution becomes asynchronous.
The `task_*` control namespace operates that shared handle regardless of which
tool produced it. There is no `task_start` because Task control does not create
domain work.

`task_status` reads any Tool Task owned by the current Thread and returns its
state, bounded progress, and terminal result when available. Its guidance
forbids polling because completion is pushed; it exists for an explicit user
status request or recovery. `task_stop` remains the generic cancellation tool,
accepts only required `task_id`, and drops Agent-ID routing and deprecated
`shell_id`.

Stopping a running task terminates its process group. A race with natural exit
preserves the first committed terminal result. Stopping a terminal task returns
its factual result without rewriting it. These semantics apply equally to a
delegated review, video generation, a build, or a plain shell script.

At the owning root Thread's next idle boundary, the Host atomically claims one
bounded batch of currently pending terminal results and may deliver them in one
Host-started completion Turn with empty canonical user input. Every Tool Task is
claimed and referenced exactly once even when several share one delivery Turn.
User-authored Turns win idle-boundary arbitration; busy roots, renderer reloads,
and app restart preserve pending delivery without replay.

### Skill and CLI

The built-in `delegate` Skill is inline and model-only. It appears in an
interactive root catalog whenever delegation is enabled; Runner readiness is an
admission state, not Skill-catalog membership. It is absent from delegated
execution, isolated Skills, and automations. This lets the root explain a
disabled, missing, or stale Runner configuration instead of silently losing the
capability when the user explicitly asks for delegation.

Its catalog description is direct: `Delegate an independent task to another
internal or external Agent and return its result to the current Agent.`

Its complete routing policy is:

- delegate only a substantial, independently specifiable task;
- use background Bash for every delegated run and return control immediately;
- omit Runner selection unless the current user request explicitly names an
  enabled non-default Runner;
- do not duplicate running delegated work locally;
- create only the few independent tasks that fit the Thread's configured local
  outstanding-work limit;
- rely on Host completion instead of polling; and
- after a non-user-initiated failure, keep verified evidence and return task
  ownership to the root; continue locally only when the root can do so safely;
- after user cancellation, acknowledge cancellation and do not continue the
  cancelled work without a new user request.

The common path is one Bash call. The model sends the input through
`bash.stdin`; no prompt or path enters shell source.

```text
delegate run --input FILE|- [--runner RUNNER_ID] [--output text|json]
delegate doctor [RUNNER_ID] [--output text|json]
delegate schema [run|result]
delegate version
```

There is no `delegate status`, cancel, Runner-list, or configuration command.
Status and cancellation are generic Tool Task operations; Runner policy belongs
in Settings. Omitting `--runner` uses the configured default. The root may pass
`--runner` only for an explicitly named Runner in the current user request; the
CLI admits only enabled and Ready Runners and never falls back. `doctor` and
`schema` are diagnostics, never common-path preflight.

The versioned input contains only task intent:

```json
{
  "version": 1,
  "prompt": "Inspect the recovery path and report concrete correctness risks.",
  "profile": "explore",
  "access": "read-only"
}
```

Bash `description` is the single display summary. Runner selection remains CLI
policy outside the task-intent document, so prompt data never gains execution
authority. `profile` is `general`, `explore`, or `plan`. These are
Runner-independent Task Profiles, not Agent types, personas, or model
containers. `explore` and `plan` enforce read-only; `plan` also prohibits
implementation. `general` may request read-only or workspace-write within the
root's ceiling.

One registry generates schema, parsing, normalization, help, admission
lowering, result envelopes, and permission classification. The CLI writes
progress to the supervisor's generic event channel, emits one terminal envelope
to stdout, and exits with a stable code. It never exposes credentials or reads
Tool Task persistence.

The Host supplies a short-lived, one-use launch capability bound to the root
Thread, Tool Item, cwd, and access ceiling. `delegate run` without it is refused.
The capability is unavailable to the delegated Runner, so knowing the CLI path
cannot create another task. Tool-call replay resolves the existing Tool Task by
source Tool Item and request digest; a mismatched replay fails closed.

### Internal Tenon Runner

The internal Runner imports the same Agent execution kernel used by the app into
a headless CLI session. It does not recursively launch the Electron app or use
`SubagentCollaboration`.

The session receives the delegated prompt, Task Profile, repository
instructions, admitted resources, and effective access. It does not receive the
root conversation. Its transcript and result are written as Tool Task artifacts;
it has no persistent, routable child Agent identity and never appears in the
Thread list.

Effective tools are:

```text
root capability ceiling
  intersect Task Profile
  intersect requested access
  intersect delegated-run hard blocks
```

It may reuse current file, foreground Bash, Web, inline Skill, MCP, and extension
tools when admitted by every layer. It cannot delegate, invoke isolated Skills,
ask the user, manage automations, control the root, start background Bash, or
call `task_status`/`task_stop`. These are runtime blocks, not prompt advice.

Provider calls use a Host broker scoped by the launch capability, so credentials
never enter the shell environment. Broker disconnect cancels the active internal
call and the CLI settles truthfully; no hidden app-side run continues after the
CLI exits.

The model and effort default to **Inherit parent**. Settings may pin a currently
available model and supported effort. If an explicit choice disappears or loses
authorization, admission refuses before provider I/O. It never inherits,
upgrades, falls back, or changes Runner silently.

### External Runners

An external Runner is a child of the trusted `delegate` process and uses its
harness's native model loop and built-in tools. Tenon does not translate each
external tool call. The Adapter only probes compatibility, builds safe argv,
normalizes events and final output, and propagates cancellation.

The CLI still owns cwd/worktree, access ceiling, sanitized environment, local
scheduling lease, timeout, bounded output, and the final result. It starts the
harness in the same process group, disables session resume, cloud/background
execution, and native Agent/Subagent features, and kills descendants on
terminal exit.

External runs use a closed configuration. Native base tools are allowed;
plugins, hooks, user MCP servers, custom skills, custom Agents, and unchecked
config are disabled. Tenon resolves repository instructions and passes them
explicitly. Broader extension support is a later capability, not arbitrary
settings passthrough.

Adapter readiness requires version-bound proof of machine-readable terminal
output, cwd, enforceable access, cancellation, and nesting denial. Prompt rules
do not count. Unsupported versions remain Detected but Not Ready.

Candidate adapters are:

- **Claude Print:** `claude -p` with machine-readable streaming, safe config,
  explicit native tools, no session persistence, and the `Agent` tool denied.
- **Codex Exec:** `codex exec --json --ephemeral` with explicit sandbox, closed
  config, and multi-agent capability disabled.
- **ACP/OpenClaw:** only after protocol negotiation proves access, cancellation,
  ephemeral settlement, and nesting denial. Installed `openclaw acp` alone is
  not enough.

Authentication remains the harness's responsibility. Discovery never logs in,
installs, updates, starts a paid call, or reads credential contents. Expired auth
after readiness is a normal Runner failure.

### User policy and local admission

Settings -> Agent -> Delegation contains:

- an **Experimental delegation** switch, off by default;
- default Runner;
- per-Runner Detected, Ready, Enabled, version, and diagnostic state;
- internal **Inherit parent** or a live model and supported effort;
- external **Harness default**, plus explicit models only when the Adapter can
  enumerate and validate a finite live catalog;
- maximum access, with external Runners read-only by default;
- bounded run duration; and
- Advanced global, per-Thread outstanding, per-Runner, and local scheduling-pool
  limits.

Startup detects known executable names and saved paths with a bounded version
probe. Detection does not authorize use. Turning on the experiment enables the
internal Runner and selects it by default; every external Runner requires its
own enable action. Disabling a Runner blocks new runs but does not discard an
active Tool Task.

Runner and model choices come from live provider or Adapter capabilities, never
from a model schema or static model list. A pinned unavailable Runner or model
makes that configuration Not Ready and causes one actionable refusal. A Tool
Task may already exist because Bash creates generic task state before launching
the CLI, but refusal starts no delegated session, Provider request, harness, or
worktree and the same Tool Task settles immediately with the admission error.

Before starting a Runner, the CLI acquires global, Thread, Runner, and local-pool
leases from a generic Host admission scheduler. These are user-configured or
conservative product limits over processes Tenon starts, not discovered Provider
capacity. Internal runs and root provider Turns may share one local pool, where
root work has priority over delegated work that has not started. Active requests
are never preempted. External Runners default to a conservative isolated local
limit; users may manually group Runners they believe share an account or other
constraint without Tenon inspecting credentials or asserting that the grouping
matches Provider reality.

A saturated local limit waits and reports a generic public phase. A full bounded
Thread or global queue refuses before Runner start. Tenon cannot observe use by
other applications, infer an API key's real concurrency, or guarantee that a
locally admitted request will succeed. Provider rate limits after start are
factual failures: no automatic retry, failover, model change, adaptive limit
change, or credential inference follows. The result may suggest that the user
lower a local limit, but never claims a diagnosed account capacity.

### Workspace, failure, and result

Read-only work uses the root cwd under a Host-enforced read-only ceiling. Every
workspace-write run gets a dedicated git worktree before Runner start. Non-git
or unisolatable writable work is refused. Unchanged worktrees are removed.
Changed or crash-ambiguous worktrees remain artifacts and are never merged or
copied automatically.

For every changed worktree, the CLI computes the base revision, changed-file
manifest, normalized patch, retained worktree path, and reported verification
evidence independently of Runner prose. Runner success means only that the
isolated run settled successfully; it never means those changes reached the
root workspace. The root inspects the evidence, applies or reconstructs accepted
changes through ordinary Bash/git operations, verifies the integrated result,
and then removes the worktree. Conflict, rejection, or uncertain recovery keeps
the worktree and patch available and produces no integration claim.

Admission refusal starts no Runner, provider call, harness, worktree, retry, or
fallback. Once started, success, failure, timeout, cancellation, malformed
output, auth/rate-limit failure, or process loss produces one CLI envelope and
one generic process receipt.

The result includes terminal status, Runner/version, effective model when
reported, duration, bounded final text or actionable error, partial-evidence
status, transcript and artifact references, worktree disposition, and factual
usage/cost when available. Missing usage is `unknown`, never zero. Runner output
is untrusted observation.

Background settlement updates the Tool Task immediately and notifies the root at
its next idle boundary. The conversation stays interactive. After a failure,
timeout, or loss, the root preserves verified partial evidence, makes no
unsupported completion claim, and takes ownership of the unfinished user goal.
It continues locally only when feasible; otherwise it reports the blocking fact
and recovery options. It does not create a replacement delegated task. A
user-cancelled task remains cancelled and triggers no automatic local takeover.

### User experience

The transcript shows ordinary Skill and Bash Items. Delegated work always
appears in a generic Tool Task strip shared by delegation, video generation,
builds, and other commands. Each row has description, running/terminal state,
elapsed time, public progress when supplied, cancel, and failure indication.
Details show bounded output, artifacts, diagnostics, and retained worktree.

There is no Agent roster, child tree, generation count, peer-message UI, resume
control, or child Thread navigation. Internal and external Runners look the same
at the Tool Task layer.

An invalid explicit model does not spin or silently switch. Settings shows the
Runner as Not Ready; if invoked, the generic Bash task settles immediately with
an actionable admission error and no delegated session starts. A running failure
updates the same generic task row and produces the same Host completion as any
failed long-running command. User cancellation reports cancellation without
asking the root to continue the work. Several results that become deliverable at
one idle boundary appear in one root completion Turn, not a burst of autonomous
Turns.

When a user names an enabled Runner, the Bash Item and task details show that
Runner. Without an explicit name, the configured default is used. An isolated
external Runner uses the Adapter's closed tool environment, not the user's full
interactive harness configuration. Writable success is described as changes
ready for root review until the root actually integrates and verifies them.

### Retirement and delivery units

| Current surface | End state |
| --- | --- |
| `agent` | Removed; capability moves to Skill + Bash + CLI. |
| `agent_message` | Removed; no steer, resume, peer, or `main` route. |
| `bash` | Preserved; gains generic durable background execution and stdin. |
| `task_status` | Added for any owned Tool Task; never used for polling. |
| `task_stop` | Preserved for Tool Tasks; Agent-ID and `shell_id` routing are removed. |
| `skill` | Preserved; gains the root-only `delegate` Skill. |
| Agent types | Removed as addressable/configurable entities; task profiles retain only intent semantics. |
| Subagent UI | Removed; generic Tool Task presentation replaces it. |

`SubagentCollaboration`, Subagent ledgers, generation routing, nesting budgets,
Role-derived spawn definitions, Agent delivery, and Agent-tree presentation are
deleted. Domain-neutral provider, tool, transcript, artifact, worktree, and
Host-turn primitives remain.

The delivery order is:

1. **Generic background Tool Tasks:** Durable supervised Bash tasks, stdin,
   restart recovery, `task_status`, generic completion, artifacts, cancellation,
   and generic task UI. This is complete and useful without delegation.
2. **Internal delegation replacement:** CLI, Skill, launch capability, provider
   broker, local admission scheduling, internal Runner, Settings, worktree
   handoff and integration evidence, experiment, and total Subagent retirement
   in one PR.
3. **Claude Print adapter:** One complete external Runner with fixtures and real
   run evidence.
4. **Codex Exec adapter:** The equivalent complete Codex Runner.
5. **ACP/OpenClaw adapter:** Only after its capability gate passes.

The internal replacement supersedes `agent-delegated-failure-truth` while
preserving immutable outcome, distinct delivery truth, partial-output honesty,
busy-root durability, and no inferred root failure. `agent-root-turn-recovery`
remains independent and collision-ordered on Host-turn and renderer surfaces.

The live check on 2026-09-03 finds PR #619 still open. It claims the Outline CLI,
built-in Outline Skill, Agent Skill/tool specs, packaging, and shared tests.
Implementation follows its merge or explicitly orders shared files after a new
`gh pr list` check. This dev plan does not edit main-owned `docs/TASKS.md` or
`CHANGELOG.md`.

### Requirements and acceptance

- **FR-1:** Background Tool Tasks are generic and durable.
  - **AC-1:** Plain Bash, delegation, and a video-generation fixture share one
    state, progress, artifact, cancel, restart, status, and delivery path.
  - **AC-2:** Generic task contracts contain no delegation or Runner concepts.
  - **AC-3:** Every terminal race or restart produces one immutable result and
    exactly one delivery claim without replay; one root completion Turn may
    carry several atomically claimed results.
- **FR-2:** Delegation is a one-call Skill and CLI workflow.
  - **AC-4:** The model catalog has no Agent/delegation tool or Runner/model enum.
  - **AC-5:** The common path uses one background Bash call, bounded stdin, and
    no speculative doctor, schema, or status call; the root remains available
    after the launching Turn.
  - **AC-19:** Omitting `--runner` uses the user-configured default; an explicit
    current-user request may select one enabled Ready Runner, and no other
    non-default selection is permitted by Skill policy.
- **FR-3:** User policy fails closed.
  - **AC-6:** Detection never enables an external Runner.
  - **AC-7:** An invalid explicit Runner/model starts no delegated session,
    Provider call, harness, or worktree and never falls back, retries, or creates
    a replacement task; any already-created generic Tool Task settles with the
    actionable admission error.
- **FR-4:** Delegation depth is one.
  - **AC-8:** Only an attested root Bash call can run `delegate`.
  - **AC-9:** Internal and external Runners have no admitted delegation route.
  - **AC-20:** Per-Thread running plus queued delegation is bounded at admission,
    so a root cannot replace nesting with an unbounded flat task burst.
- **FR-5:** Runners share one truthful result contract.
  - **AC-10:** Internal and external runs normalize terminal output, partial
    evidence, errors, artifacts, cancellation, and factual usage.
  - **AC-11:** External Runners use native base tools without Tenon tool
    translation or unchecked extensions.
- **FR-6:** Root work remains responsive.
  - **AC-12:** Work above configured local Thread, Runner, or pool limits queues,
    and root work precedes only delegated work that remains in Tenon's local
    queue; active work is not preempted.
  - **AC-13:** Every background failure updates the generic task UI, reaches the
    root, permits new user input, and returns ownership without promising that
    local completion is possible.
  - **AC-21:** A user-authored Turn precedes pending automatic completion at the
    same idle boundary, and all currently deliverable results may be handled in
    one bounded completion Turn.
  - **AC-22:** User cancellation reaches the root as cancellation and never
    triggers automatic continuation of the cancelled work.
  - **AC-23:** Tenon never presents configured local limits or observed remote
    failures as discovered API-key, account, Provider, or cross-application
    capacity.
- **FR-7:** Writable work is isolated.
  - **AC-14:** Writable runs start only in a dedicated worktree; changed or
    ambiguous state is retained and never integrated automatically.
  - **AC-24:** Every changed worktree returns a CLI-computed base revision,
    changed-file manifest, patch, path, and verification evidence; the root
    distinguishes Runner success from successful integration and verifies any
    applied result before claiming completion.
- **FR-8:** The Subagent product is retired.
  - **AC-15:** Live guards find no spawn/message schema, Agent-ID routing,
    nested-generation authority, Role-backed Agent type, or Agent-tree UI.
  - **AC-16:** `general`, `explore`, and `plan` remain enforced Task Profiles
    without Runner, model, persona, or nesting policy.
- **FR-9:** Experimental value is measured.
  - **AC-17:** Sequential and delegated workflow replay compares wall time,
    total usage/cost, failures, duplicate work, and ownership-recovery cost.
  - **AC-18:** Missing usage remains unknown; a configured-local-limit fixture
    queues deterministically, while an observed remote rate-limit response
    remains a factual failed run and does not mutate scheduling policy.

### Verification

Build a real task corpus before freezing CLI names. It covers research, planning,
multi-file review, default and explicitly named Runners, workspace writes and
integration conflicts, a long video-like process, invalid model, local queue
saturation, observed remote rate limits, user cancellation, malformed output,
process loss, restart, partial artifacts, simultaneous completions, and a user
Turn racing with completion delivery.

Generic tests cover supervisor identity, stdin, progress validation, status,
process-group stop, exit races, receipt recovery, loss, ownership, artifact
bounds, atomic completion batching, and exactly-once Host delivery. Delegation
tests cover the always-background one-call path, launch capability, default and
user-named Runner selection, model inheritance and invalidation, profiles, tool
ceilings, local admission priority and bounds, unknown remote capacity,
worktree evidence and integration outcomes, result normalization, ownership
recovery, cancellation without takeover, and absence of nesting. Each external
adapter adds version-bound probe, argv, closed-config, access, stream,
cancellation, and real-harness evidence.

Retirement checks derive their queue from live symbols, schemas, fixtures,
specs, and packaged resources. UI/E2E checks cover feature-off, settings,
running/success/failure/lost tasks, restart, status, cancellation, artifacts,
and no Agent-tree UI in light/dark and accessibility modes.

Each PR runs `bun run typecheck`, relevant Core and renderer tests, focused E2E,
`bun run docs:check`, `git diff --check`, and packaged CLI smoke. Shipped design
is folded into current specs in the same PR.

## Open questions

None for generic Tool Tasks or the internal replacement. External names do not
guarantee admission: Claude and Codex are first candidates; ACP/OpenClaw remains
deferred until its protocol proves access, cancellation, ephemeral settlement,
and nesting denial.

## Implementation checklist

- [ ] Re-run collision checks and open one scoped Draft PR per delivery unit.
- [ ] Ship and verify generic background Tool Tasks without delegation concepts.
- [ ] Freeze the real task corpus, then the CLI and result registry.
- [ ] Ship the complete internal replacement and remove all Subagent surfaces.
- [ ] Fold behavior into current specs and run retirement plus full verification.
- [ ] Add each proven external Runner as a separate complete feature.
