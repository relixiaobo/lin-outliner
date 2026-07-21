# Codex Automations

## Goal

Add one Codex-style Automation system for scheduled and repeated agent work.
Automations are host-owned schedule definitions that start a new Thread or add a
Turn to an existing Thread; they never materialize an Issue, AgentSession,
generic Run, hidden Channel, or command-node scheduler.

This is a clean replacement against empty agent data. Old definitions and
execution history are deleted outside the product; the new scheduler never
detects, imports, migrates, aliases, or adapts RecurringIssue, command schedules,
or any previous persistence format.

This is one complete feature in one PR and depends on `agent-codex-core`. It may
run in parallel with `agent-codex-memory` after the core PR lands because it owns
the Automation protocol, scheduler service, persistence, execution bindings, and
Automation UI.

The behavioral reference is OpenAI Codex's current Automations documentation and
commit `841e47b8fb113a201b68e0f1f5790ba22836a241`, including:

- the official `Scheduled tasks` / Automations manual
  (`https://learn.chatgpt.com/docs/automations?surface=app`)
- `ThreadSource::Feature("automation")`
- host-owned `codex_app.automation_update` tool
- Turn `additional_context["automation_info"]`
- `ScheduledTaskSummary` as plugin-provided configuration input
- `codex-rs/app-server-protocol/src/protocol/v2/plugin.rs`
- `codex-rs/core/src/tools/handlers/tool_search.rs`
- `codex-rs/core/tests/suite/additional_context.rs`

Codex core does not implement a general cron engine. Tenon's Electron main
process is therefore the scheduling service; the agent Thread runtime remains a
consumer of due work rather than the owner of time.

The Codex-backed product contract is: standalone schedules create a new Thread
per occurrence, existing-Thread schedules preserve context, RRULE is the advanced
schedule format, local/project worktree execution is supported, skills/plugins
may be selected, and execution is unattended. Tenon retains its separately
ratified Full Access host boundary instead of adopting Codex sandbox or approval
policy concepts. Codex source does not expose its full scheduler implementation.
Durable claims, latest-only catch-up, overlap coalescing, and cleanup below are
explicit Tenon reliability choices, not claims about undocumented Codex internals.

## Non-goals

- Preserve RecurringIssue, Issue schedule, AgentSession trigger, or old scheduled
  execution records. No legacy table, DTO, IPC route, parser, or compatibility
  branch remains after the replacement.
- Reuse "Run" as a general agent entity. `AutomationRun` is a narrowly scoped
  dispatch/binding record whose actual execution is a canonical Thread and Turn.
- Put recurrence state on document command nodes, dates, Channels, or Goals.
- Guarantee execution while the desktop app is not running. Automations requiring
  local files require the app and machine to be available.
- Build a remote scheduler, cloud queue, or multi-device lease protocol.
- Migrate existing recurring Issues or schedule strings.

## Design

### 1. Ownership and canonical model

Add the feature beside, not inside, the Thread runtime:

```text
src/core/agent/
  automation.ts

src/main/agent/automations/
  AutomationService.ts
  AutomationStore.ts
  AutomationScheduler.ts
  AutomationDispatcher.ts
  AutomationTool.ts
  AutomationWorktree.ts

src/renderer/agent/automations/
  automationStore.ts
  AutomationsView.tsx
  AutomationEditor.tsx
  AutomationRunsView.tsx

<userData>/agent/
  automations.sqlite
```

`Automation` is the only schedule definition. It contains:

- stable `id`, `name`, and durable `prompt`
- `schedule` with canonical RFC 5545 RRULE plus IANA `timezone`
- `destination`: `standalone` or `existingThread`
- optional destination `threadId` for existing-Thread delivery
- zero or more local project bindings, each with `cwd` and
  `executionMode: local | worktree`
- optional model, reasoning effort, tool, skill, and plugin selections
- status `active | paused | completed`
- created/updated timestamps and derived next occurrence

Interval, daily, weekly, and custom controls all compile to the same RRULE;
there are no parallel schedule formats. A one-shot schedule becomes `completed`
after its occurrence is durably claimed. Plugin `ScheduledTaskSummary` values are
configuration templates that create an Automation through the same service; they
are not another persisted task type.

`AutomationRun` contains only scheduling and routing facts: `id`,
`automationId`, `scheduledFor`, optional project binding, claim/dispatch state,
`threadId`, optional `turnId`, worktree metadata, `readAt`, timestamps, and a
pre-Thread dispatch error if one occurred. Once a Turn starts, its status, items,
result, and error remain authoritative; Automation UI joins through `threadId`
and `turnId` instead of copying execution state. A dispatched binding is valid
only when that Turn's immutable provenance names the same AutomationRun ID.

The persisted dispatch states are `pending`, `dispatched`, `failed`, and
`omitted`. `pending` owns the durable claim; `dispatched` must reference a Thread
and Turn; `failed` is limited to failures before a Turn exists; `omitted` records
coalesced/missed occurrences. There is no duplicated completed/failed execution
status after dispatch.

An omitted record is an aggregate `{ from, through, count }`, not one row per
missed tick. The definition also stores a durable evaluated-through cursor, so a
long offline interval advances in bounded work while preserving an auditable
summary of what did not run.

### 2. Durable scheduler service

`AutomationStore` owns `automations.sqlite`, its current empty-data schema,
Automation definitions, and AutomationRun claims. Core state/history, Goal, and
Memory databases contain no Automation tables. Every project binding has a
stable ID; the no-project case uses a non-null reserved binding key. The store enforces a
unique `(automationId, scheduledFor, projectBindingKey)` key without relying on
SQLite's nullable-unique behavior. The scheduler calculates occurrences in the
stored IANA timezone, persists a claim before dispatch, and therefore never
starts the same occurrence twice after restart or resume.

The claim allocates and stores the standalone `threadId` before Thread creation;
ThreadService creation with that UUIDv7 is idempotent. Existing-Thread claims
store their destination ID. Both destinations start input with
`clientUserMessageId=AutomationRun.id`, so a retry after Turn acceptance returns
the existing binding instead of appending a second Turn. Startup dispatches or
reconciles pending claims before calculating new occurrences.

The Electron main process starts one scheduler after stores and the Thread
service are ready, stops it during quit, and wakes it on a bounded timer and
`powerMonitor.resume`. The next wake is derived from active Automations rather
than one timer per definition.

If the app was unavailable across several occurrences, startup/resume claims at
most the latest missed occurrence per Automation/project binding and records all
older occurrences in one omitted range, avoiding both an execution storm and an
unbounded row-writing loop. An active occurrence never overlaps another
occurrence of the same Automation/project binding. The next due occurrence waits
until the current one is terminal; stale waits are coalesced to the latest due
occurrence with the same aggregate omission rule.

Definition edits are revision-checked. A scheduler claim stores the definition
revision and effective configuration used for that occurrence, so changing the
prompt or cadence cannot mutate an already started Turn.

Ordinary edits affect only unclaimed occurrences; an already pending claim keeps
its captured revision. Pause and delete atomically convert undispatched pending
claims to `omitted` with a reason, while a dispatched Thread/Turn continues as
canonical history. Delete is a scheduler tombstone, not a hard row removal, so
AutomationRun history retains its name/configuration snapshot and foreign-key
integrity while the definition disappears from active management views.

### 3. Destination semantics

For a `standalone` Automation, every occurrence creates a fresh persistent root
Thread with `threadSource=automation`, then starts its first Turn from
the saved prompt. The new Thread has independent context and appears under the
Automation's recent runs and normal Thread history.

For an `existingThread` Automation, every occurrence resumes the target Thread
and starts a new Turn from the saved prompt, preserving that Thread's context.
The target must be persistent and user-addressable. If it already has an active
Turn, dispatch remains claimed and waits for Thread idle; repeated due
occurrences coalesce according to the scheduler rule above.

Both dispatch paths use ThreadService's privileged feature entry and persist
this immutable provenance before model execution:

```ts
turn.provenance.trigger = {
  kind: "feature",
  feature: "automation",
  ref: automationRun.id,
};
```

For standalone and existing-Thread delivery alike, `AutomationRun.turnId` and
the Turn's provenance `ref` must point to each other. Startup reconciliation
accepts a dispatch as complete only when this pair matches. Renderer IPC, prompt
text, model output, tools, and plugins cannot invoke the privileged entry or
author, copy, or rewrite this provenance.

Both modes attach trusted application context under
`additionalContext.automation_info` as `{ kind: application, value }`, containing
Automation identity, scheduled time, destination, project/worktree facts, and
the durable prompt revision. Main creates this entry; renderer or prompt input
cannot claim application trust. This is context for the Turn, not a ThreadItem
or a second system message stored by the renderer. It helps the model understand
the schedule but is never used to establish Automation provenance or Memory
eligibility.

Automations do not create `ThreadGoal`s. A user may deliberately target a Thread
that already has a Goal, in which case the Goal extension observes the resulting
Turn normally. Schedule status and Goal status remain independent.

### 4. Projects and worktrees

An Automation with no local project runs without a filesystem workspace. A
non-Git project runs in its configured local directory. A Git project may run in
that local checkout or in a dedicated worktree created for the AutomationRun.

Worktree creation, detached-HEAD base, containment, snapshots, pinning, and
cleanup are host-owned and recorded before the Turn starts. A worktree survives
while its AutomationRun is active or pinned. Unpinned completed worktrees follow
a bounded recent-worktree retention limit; before removal the host records a
restorable snapshot and clears only a worktree it created under its managed root.
Cleanup never deletes the source checkout, an unrecognized worktree, or a
user-authored branch.

Multiple project bindings create one AutomationRun and Thread per binding for a
standalone Automation. Existing-Thread Automations accept at most one project
binding because one Thread has one sticky working context. Creation/update
rejects a binding whose workspace does not match the destination Thread's
effective environment; dispatch never silently retargets an existing Thread.

### 5. Standing authorization and unattended execution

Creating or enabling an Automation is standing authorization for its future
occurrences to perform the saved work under the current OS account's Full Access.
Automation does not add a sandbox, permission mode/profile, approval policy,
managed fallback, risk confirmation, or pause/resume authorization flow. Each
occurrence resolves its saved configuration revision into an effective tool
catalog; current explicit user blocks are checked again at every tool dispatch,
and native OS, authentication, provider, and service failures are returned by
their owners. A tool that remains available has the same host-account authority
as it has in an interactive Thread.

An Automation Turn may call root-only `request_user_input` for missing product
input. That sets the canonical Thread `waitingOnUserInput` flag and keeps the
occurrence active while later due work coalesces, but it can never request or
grant authorization. The Automations view links to the canonical Thread input
request instead of copying it or inventing an Automation execution status.

Skills and plugins are resolved at each occurrence from the saved selections.
Missing or disabled dependencies fail visibly before model execution. A skill or
foreground Thread can request an Automation create/update only through the
host-owned `codex_app.automation_update` tool; model input never writes scheduler
tables.

### 6. Host tool and transport

`codex_app.automation_update` supports Codex's create, update, view, and delete
modes.
Mutating modes use strict schemas for prompt, destination, RRULE/timezone,
project bindings, model/effort, tools, skills, plugins, and status. Main performs
path, Thread, schedule, dependency, and tool-catalog validation and returns the
canonical Automation DTO or deletion receipt. Current explicit blocks remain
dispatch-time policy and are not copied into the definition. No tool or renderer
schema accepts a permission profile, sandbox, or approval policy.

Preload exposes canonical list/read/create/update/pause/resume/delete/start-now
operations plus Automation/AutomationRun change notifications. `start-now`
creates an immediate uniquely keyed AutomationRun through the same dispatcher;
it does not bypass saved configuration, current explicit blocks, worktree, or
destination logic.

Deleting an Automation stops future claims and omits undispatched pending claims,
but does not delete dispatched Threads, Turns, or retained AutomationRun history.
Pausing applies the same pending-claim rule and prevents new claims. Completing a
one-shot definition prevents new claims while preserving history.

### 7. User surface

The user-visible entity name is "Automation", and the top-level view is
"Automations". "Scheduled" may describe timing but is not a second object name.
The view provides active, paused, and completed filters; unread findings; next
occurrence; and recent Automation runs joined to their canonical Threads/Turns.

The Automation editor supports:

- prompt and name
- standalone versus existing-Thread destination
- interval, daily, weekly, and custom RRULE schedule controls
- timezone
- no project, local project, or isolated worktree
- model and reasoning effort
- tools
- skills and plugins
- pause/resume, Start now, and delete commands
- pin/unpin for worktree retention

Opening a recent Automation run navigates to its Thread and Turn. The detail view
may show scheduler claim/dispatch failures, but it never renders a copied
transcript or an Issue Activity timeline.

### 8. Destructive replacement and documentation

`agent-codex-core` removes the old RecurringIssue and Issue scheduler before this
plan begins. This plan must also verify that no command-node or legacy agent
scheduler remains as an alternative path. Generic date-field recurrence may
remain a document value feature, but it cannot dispatch agent work; all scheduled
agent execution belongs to `AutomationService`.

`AutomationStore` initializes only its current schema. Product startup never
opens or inspects an old schedule store, and a fresh-userData integration test
fails if any old scheduler directory, file, table, command, or default definition
is recreated. Old development userData is wiped in full before validation.

Add `docs/spec/agent-automations.md` as the sole current scheduled-agent-work
authority. The core and command specs link to it instead of duplicating schedule
or dispatch rules, and `docs/spec/README.md` indexes it. Old scheduled-routine,
scheduled-work, and Issue-manager plans remain history only and are
archived/superseded by the main integration gate when it updates
`docs/TASKS.md` and `CHANGELOG.md`.

A terminology/ownership guard rejects `RecurringIssue`, scheduled AgentSession,
Issue-trigger schedules, and any second scheduler that starts agent execution.

### 9. Risks and mitigations

- **Duplicate or overlapping execution:** persist the unique occurrence claim
  before dispatch and serialize one active occurrence per Automation/project.
- **Busy existing Thread:** retain one pending claim, start only through
  `tryStartTurnIfIdle`, and coalesce later due occurrences to the latest.
- **Unattended work exceeds its saved scope:** Automation creation is explicit
  standing authorization; every occurrence resolves the saved tool selections,
  reevaluates current explicit blocks, records capability audits, and surfaces
  native failures in its canonical Thread.
- **Automation content leaks into Memory:** every dispatched Turn has immutable
  host-authored Automation provenance, including delivery into an existing user
  Thread; Memory filters that provenance rather than relying on Thread source or
  model-visible context.
- **Destructive worktree cleanup:** operate only inside the managed root, verify
  ownership, snapshot before removal, and preserve pinned worktrees.
- **Execution-model drift:** AutomationRun stores routing only; every transcript,
  result, error, and terminal execution status is read from Thread/Turn.

### 10. Collision result

At drafting time, open PR #422 owns unrelated renderer date-count files.
There is no overlap. This plan consumes the Thread/Turn APIs from
`agent-codex-core`, owns the isolated Automations directories and their small
preload/navigation integration, and does not modify Memory files.

## Open questions

None. Ratifying this plan ratifies latest-only catch-up, no overlapping
occurrences per Automation/project binding, standalone versus existing-Thread
destinations, scoped AutomationRun bindings, Full Access standing authorization,
trusted Turn provenance, and service-layer scheduling.

## Implementation checklist

- [ ] Confirm `agent-codex-core` is merged and have the main agent add this plan
  to `docs/TASKS.md`; open the Draft PR claim.
- [ ] Define Automation, schedule, project binding, AutomationRun, and the
  extension-owned `automations.sqlite` contracts.
- [ ] Implement strict RRULE/timezone parsing, occurrence calculation, durable
  revisioned definitions, and unique claims.
- [ ] Implement timer/resume wakeup, latest-only catch-up, overlap prevention,
  coalescing, and shutdown behavior.
- [ ] Implement standalone and existing-Thread dispatch through canonical
  Thread/Turn APIs with reciprocal AutomationRun provenance and trusted
  automation context.
- [ ] Implement project/worktree lifecycle and unattended Full Access execution
  through saved tool catalogs, current explicit blocks, and native failures.
- [ ] Implement `codex_app.automation_update`, preload APIs, notifications, Start
  now, and pause/delete/tombstone/retention semantics.
- [ ] Delete every RecurringIssue, Issue schedule, AgentSession trigger,
  command-node scheduler, legacy store/reader, IPC command, settings surface,
  test fixture, and compatibility branch before validating fresh userData.
- [ ] Implement the Automations list, editor, filters, unread state, recent-run
  joins, and Thread/Turn navigation.
- [ ] Add DST, crash, duplicate-claim, revision race, busy Thread, catch-up,
  post-Thread/post-Turn crash recovery, bounded omission aggregation, worktree
  containment/cleanup, missing dependency, provenance-integrity, explicit-block,
  and `request_user_input` wait tests.
- [ ] Rewrite active scheduling specs and add legacy-scheduler ownership guards.
- [ ] Validate from empty userData with `bun run typecheck`, `bun run test:core`,
  `bun run test:renderer`, focused E2E coverage, `bun run docs:check`, and
  `git diff --check`.
