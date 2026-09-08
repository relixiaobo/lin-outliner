# Agent Automations

Automations are Tenon's single host-owned mechanism for scheduled and repeated
agent work. An Automation owns time and dispatch configuration; canonical
Threads, Turns, Items, Goals, and Memory boundaries continue to own execution.
There is no schedule tied to an Issue, prior session entity, command Node, or
parallel agent run ledger.

## Domain Model

An `Automation` is one revisioned definition containing:

- UUIDv7 identity, name, and durable prompt
- one RFC 5545 `DTSTART` plus `RRULE` and one IANA timezone
- a `standalone` or `existingThread` destination
- zero or more stable project context hints whose saved root is a lookup value,
  using Full Access or an explicitly requested isolated execution policy
- optional provider, model, and reasoning selections
- `active`, `paused`, or `completed` status and timestamps

Each explicit context hint has a stable Host-issued UUIDv7 `contextHintId` and
a source of either `{ kind: project, projectId }` or
`{ kind: directory, rootHint }`. The latter is
an absolute lookup path, not a persisted canonical execution address. The Host
may validate its current availability when saved but does not freeze the
validation result as runtime identity. There are at most 32 hints. Zero hints
means one implicit `default` hint using the documented Host default. An
existing-Thread destination accepts at most one explicit hint.
Directory and Project-ID sources are executable. Project sources resolve through
`ProjectService` under the scheduler lifecycle lock, require a live saved directory,
and never fall back to the Host default or a guessed directory. Create, edit,
resume, and reactivation validate that live hint before persistence.

Hint IDs identify scheduling/continuity slots within an Automation. They survive
reordering and edits to a slot's source or policy, do not encode a directory,
and are never reused after removal. A removed hint's history retains its saved
source. Project root-hint edits affect future claim snapshots, not pending
claims or existing execution contexts. Claim creation captures the effective
root hint and display values under the Project lifecycle fence. A Project-source
run requires an identity-matching `projectSnapshot` containing the name, canonical
root, revision, and timestamps. Dispatch and history use this frozen value without
consulting the catalog; the admitted Automation input includes the frozen Project.
If that saved path now resolves elsewhere, dispatch fails before Turn admission.
A root edit changes only later claims. Clearing the optional root freezes that
unavailable value into new claims; each fails dispatch with a visible error, so
one invalid hint cannot abort scheduling for unrelated Automations.
The implicit `default` slot lasts for the definition's lifetime. It is inactive
while explicit hints exist; returning to zero hints reactivates its cursor from
edit time without replaying its previously claimed occurrences.

The accepted schedule form contains exactly one floating local `DTSTART` and one
RRULE. Hourly, daily, weekly, monthly, and yearly frequencies are supported.
Local wall time remains stable across timezone offset changes. A nonexistent
spring-forward wall time is skipped; an ambiguous fall-back wall time runs once
at its first matching instant. A UTC `UNTIL` remains an absolute instant and is
checked after converting each wall occurrence; a local `UNTIL` remains a wall
boundary. The renderer's Once, Hourly, Daily, Weekdays, Weekly, and Custom
controls all produce this same representation.

An `AutomationRun` is a narrow scheduling and routing record. It captures the
Automation revision, scheduled instant, one context hint, complete saved
definition and configuration-selection snapshot, optional isolation policy,
reciprocal Thread/Turn IDs, read state, and pin state. Main resolves a fresh
ExecutionAddress, ExecutionPolicy, and ContextSnapshot for each new dispatch,
then stores `dispatchSnapshotRef` referencing immutable context evidence. The
dispatch snapshot links to the immutable claimed run and contains source/execution
contexts, frozen effective configuration, and bounded Automation input. The run
snapshot owns its captured hint; its worktree metadata owns any prepared intent.
The run row holds references; it is not a second source of execution facts.
Provider/model selection and address validation fail dispatch when unavailable;
incomplete discovery uses a durable degraded snapshot. The run does not copy model
output, Turn status, Goal status, tool history, or errors that occur after Turn
admission.

Once `dispatchSnapshotRef` exists, retries reuse those bytes and revalidate the
captured canonical identities. They do not resolve a redirected root alias or
reload a changed configuration file. A changed existing destination configuration
fails admission rather than silently replacing its prepared selection.

Run routing states are:

- `pending`: the occurrence is durably claimed but has no accepted Turn
- `dispatched`: the canonical Turn was accepted and reciprocal provenance is
  durable
- `failed`: dispatch failed before a Turn existed
- `omitted`: the occurrence was superseded by catch-up, overlap, update, pause,
  or delete

Omitted occurrences use one bounded `{ from, through, count, reason }` audit
record per contiguous batch. Aggregation never crosses an intervening successful
run, context hint, or Automation revision.

## Scheduling And Durability

`AutomationStore` owns `<userData>/agent/automations.sqlite`. Definitions,
per-context-hint evaluated-through cursors, overlap deferrals, and run claims
commit with SQLite WAL and full synchronous durability. The unique claim key is
`(automationId, contextHintId, occurrenceKey)`: scheduled occurrences use their
UTC scheduled instant in a `scheduled` namespace, while Start now uses a durable
request ID in a `manual` namespace, reused on retry. The `default` hint is an
explicit key value, not SQL null. Canonical paths,
Project IDs, worktree identities, and definition revisions are not claim keys.
An edit cannot duplicate an already claimed occurrence by changing its path or
revision. Standalone claims reserve their UUIDv7 Thread identity before any
Thread side effect. Cursors and overlap state use `(automationId, contextHintId)`;
run claims capture the exact definition revision and hint values they consumed.

The Electron main process owns one `AutomationScheduler`. It starts after
Thread and Memory recovery, wakes for the nearest active schedule, retries
pending dispatches, wakes when the machine resumes, and stops before Agent stores
close. Timer failures report an error and retain a future wake instead of
silently disabling scheduling. Automations run only while the desktop app and
required local machine resources are available.

Startup reconciles all pending claims and dispatched provenance bindings without
a renderer pagination cap before calculating new work. Across an offline
interval, each Automation/context hint claims only the latest missed
occurrence and stores older ones as one `catchUp` omission. While one occurrence
is active, later due work is persistently marked as overlap-deferred. When the
active Turn becomes terminal, only the latest deferred occurrence starts and
older due work becomes an `overlap` omission. One active occurrence per
Automation/context hint is therefore enforced across normal wakes, Start now,
edits, and restart. This is a scheduling rule; different hints that resolve to
the same admitted scope use the common Tool Task claim. That claim coordinates
declared addresses only; arbitrary shell/native launcher effects elsewhere
have `cwd-only` coverage, not a universal write-serialization guarantee. Hint
IDs grant no filesystem ownership or permission.

Create, update, pause, resume, delete, Start now, worktree pinning, scheduled
admission, Project hint capture/deletion fencing, and worktree cleanup share
the scheduler lifecycle ordering. Revision preconditions
reject stale edits. Before pause or delete classifies a pending claim, the host
looks up its `clientUserMessageId` binding and durably restores any already
accepted Turn as `dispatched`. Pause and delete then atomically convert only
genuinely undispatched claims to omissions; an already dispatched Turn continues
as canonical history, and a paused or completed definition cannot Start now.
Delete tombstones the definition so run snapshot and foreign-key history remain
intact. Any finite RRULE definition becomes completed after every context hint
has durably claimed its final occurrence. This means recurrence is exhausted;
its last claims may still be pending or executing. Historical runs are never
resumable. Changing a completed definition's schedule reactivates the definition
from the edit time only after validating its current hints, destination, and
configuration; other edits preserve its completed state. Direct resume of a
completed definition is rejected.

An update first reconciles accepted Turns, then atomically omits genuinely
undispatched claims from the replaced revision with reason `updated`. Already
dispatched work keeps its captured snapshot and continues to occupy its hint's
overlap slot. Schedule edits reset evaluated-through cursors from edit time and
clear old deferrals; a new hint starts at its addition time, and a removed hint
retires its cursor. Unchanged schedules/hints retain their cursors. A source or
policy edit cannot revive an omitted occurrence or redirect a running task.
Resume validates the current definition and wakes scheduling from durable
cursors using the same catch-up/coalescing rules. It does not resume old runs.

Start now uses the saved definition and same durable claim/dispatch path. It does
not bypass no-overlap, model validation, execution-context admission, inherited
Thread configuration, or explicit capability blocks.

## Canonical Dispatch

A standalone occurrence creates one persistent root Thread per context hint
with `threadSource` classified as feature `automation`. It uses the Automation
name, captured model selection, default Configuration Profile, and a freshly
admitted dispatch snapshot. Its composer is read-only because
only the host feature path may add Turns.

An existing-Thread occurrence adds a Turn to one active persistent root user
Thread and preserves that Thread's history, provider, and Goal. Dispatch uses
the claimed Automation hint to prepare its initial context independently of
Thread metadata or Project membership. A busy Thread leaves the claim pending
until the same single-Turn coordinator becomes idle.

The initial dispatch snapshot is source-labelled input to the Turn, not a
sticky execution directory. Each Tool Task resolves and records its actual
address, policy, and snapshot, including explicit cross-directory calls. An
isolated policy applies equally to either destination and is enforced at each
task; an existing Thread neither disables nor owns that policy.

Both destinations call the privileged `ThreadService` feature admission with
`clientUserMessageId=AutomationRun.id`. Retrying after a crash therefore returns
the already accepted Turn instead of appending another. Every dispatch attempt
performs this lookup before address/worktree preparation and configuration
resolution. A claim without prepared evidence resolves its saved hint once and
persists the resulting dispatch snapshot before Turn admission. Retries of that
same prepared claim validate and reuse its recorded identity; only a new
occurrence may resolve a new identity. Failure finalization repeats the accepted
Turn lookup and leaves the claim pending if the reciprocal run binding cannot
yet be committed. Before model execution,
the Turn durably records:

```ts
turn.provenance.trigger = {
  kind: "feature",
  feature: "automation",
  ref: automationRun.id,
};
```

The run's `threadId`/`turnId` and the Turn trigger must agree. Startup rejects a
surviving Turn with mismatched provenance. A user may later delete the canonical
Thread; the historical routing record remains dispatched and auditable, opening
it reports the ordinary missing-Thread error, and its absence does not disable
future scheduling.

Main also injects trusted `additionalContext.automation_info` with Automation,
run, revision, occurrence/context-hint identity, scheduled time, destination,
and the initial dispatch snapshot reference and source-labelled observations.
It distinguishes the saved root hint from the resolved source and any isolated
execution address. Later task contexts and discovery successors use appended
`system-reminder` evidence; they never rewrite the initial dispatch snapshot.
These values are admitted as canonical context-evidence payloads, not a direct
prompt overlay or renderer-authored input. The Turn trigger remains the
provenance authority; reminder text is not used to reconstruct it.

All Automation input follows
[Execution Context Publication](agent-model-runtime.md#execution-context-publication).
Capture `automation_info`, including `recentRuns` when applicable, at Turn
admission. Retry and historical projection reuse that admitted payload; they
do not rebuild the old digest from current run outcomes or Project metadata.
Later meaningful updates append new evidence. A standalone run starts its own
baseline and Thread cache affinity; an existing-Thread run keeps that Thread's
history and affinity. Neither the scheduling hint nor a dispatch snapshot is a
provider cache key. Dispatch/task directories do not implicitly select another
root configuration source. Explicit Automation configuration selection retains
the owning configuration contract and existing-Thread preservation above.

## Run Continuity

A standalone run is a Thread with no history, so on its own it repeats a failed
predecessor without knowing there was one. Its Thread materializes the canonical
transcript artifact owned by Agent Core, and `automation_info` carries a `recentRuns`
digest of the runs before it. Everything stays pull-based: the digest is a
pointer, and the transcript enters context only if the model reads it with the
existing file tools. No model tool is added.

`recentRuns` holds the three most recent runs of the same Automation and
`contextHintId`, newest first, excluding the current occurrence, queried by
that logical slot in SQL. An Automation's hints interleave, so history from a
different hint must not displace this slot's predecessors. Each entry names its
captured hint and dispatch snapshot reference, with bounded resolved-address
display when available. The same hint may have resolved to another directory
after an edit or filesystem change; those entries are explicitly labelled as
different context, never presented as proof about the current checkout. A
failed/omitted run with no prepared snapshot reports its address as unavailable.

Each entry carries the run id, scheduled time, finish time, a status, one
bounded outcome line, and a nullable `transcriptPath`. The outcome is derived
from the canonical Turn every time the digest is built — an `AutomationRun`
records how a run was *dispatched*, never how it ended, and it stays that way:
`dispatched` plus the Turn's status and completed final assistant text,
`failed` from the run error, `omitted` from the omission reason and count, and
`unknown` when the user deleted the Thread but kept the routing record. No
outcome field is written down, so there is no second ledger to disagree with the
first. Only a run that owned its Thread reports a `transcriptPath`.

Outcome lines are single-lined and bounded on the way in. They are previous
model output entering a *trusted* application context, so newlines and
separators are stripped: a preview must not be able to forge another entry or
read as an instruction addressed to the run receiving it.

Doctrine rides in the same context as a fixed `guidance` string emitted first,
ahead of the data it governs — when a prior run failed, grep its transcript
before repeating the work, and treat transcripts and previews as records and
untrusted data. An existing-Thread run gets neither `guidance` nor
`recentRuns`: its predecessors are already Turns in the Thread it is joining.

A12 covers the digest end to end and as a whole. Every lookup is guarded, and a
history that cannot be read yields an empty list rather than a partial one — a
run loses a hint, never its dispatch. Retention follows the existing run-record
retention; there is no new policy knob.

Automations never create a parallel Goal. A Turn in an existing Thread is
observed by that Thread's current Goal extension normally. Automation-triggered
Turns are ineligible for implicit Memory extraction, retrieval, citations, and
Memory graph mutation even when delivered to an ordinary user Thread. Memory
uses immutable Turn provenance rather than Thread source or prompt text for this
decision.

## Configuration And Authority

Each claim stores the exact Automation definition revision. At dispatch, the
host validates its optional provider, model, and reasoning selections against
the current provider catalog and credentials. Create and update validate current
selections before persistence; dispatch repeats validation because credentials
and model catalogs may change before a future occurrence. An existing-Thread
destination rejects explicit selections that differ from its persisted provider,
model, or reasoning configuration both when saved and when dispatched.

Automation has no public Profile, tool, Skill, Plugin, or MCP selection fields.
A standalone occurrence inherits those capabilities from the default
Configuration Profile selected at dispatch; an existing-Thread occurrence
inherits the destination Thread's complete persisted configuration. These capability
ceilings remain host-private and are enforced by the normal Turn runtime. A
prompt may invoke an available Skill explicitly with `$skill-name`; the prompt
text does not create a separate Automation allowlist or dependency record.

Creating or resuming an Automation is standing authorization for future
occurrences under Tenon's Full Access model and any explicitly selected
isolation policy. Automation introduces no separate permission mechanism;
requested isolation uses the common Host policy and fails closed when
unavailable. Current explicit capability blocks and native provider,
operating-system, filesystem, network,
and service failures are evaluated by their existing owners. A root Automation
Turn may use `request_user_input` for missing product input; while its Turn waits,
later occurrences continue to coalesce instead of overlapping.

The root-only `automation_update` model tool provides strict create, update,
view, and delete modes over the same service. Its schema is one flat object
discriminated by `mode`; the decoder enforces the exact per-mode field sets at the
write boundary and, with the shared Automation decoders, rejects unknown fields,
invalid UUIDv7 identities, empty updates, unsupported schedules, and inputs beyond
the shared length/count bounds. The addressed identity and expected revision come
from the call, never from the patch. It is
subject to the `agent.automation.manage` capability action like every other
model tool.

## Execution Addresses And Worktrees

Each new occurrence resolves its captured hint through fresh `realpath` and
records the requested path, canonical directory, and root/worktree identity in
its dispatch snapshot. With no explicit hint it resolves the documented Host
default. Save-time validation is not an equality constraint on future runs:
for example, a symlink may resolve differently on the next occurrence, and both
runs must show their distinct resolved addresses. Unavailable hints return
structured dispatch failure; they never fall back to a Thread directory or to
an old Project root. Once a dispatch is prepared, identity drift fails its
admission/recovery instead of redirecting that occurrence.

Worktree isolation resolves the source Git checkout and captures its exact
`HEAD`, shared Git identity, deterministic managed destination, and cleanup
owner in durable preparation intent before the first Git mutation. Git
preparation is an ordinary Host-owned Tool Task. The resulting detached
worktree under `<userData>/agent/automation-worktrees/` supplies the execution
address/resource reference in the final dispatch snapshot before Turn admission.
The original hint and resolved source address remain evidence, not cleanup
targets. Non-Git roots cannot satisfy requested worktree isolation.

Recovery looks up the accepted Turn first, then any saved preparation intent or
dispatch snapshot. It never invokes fresh preparation when a persisted intent
already owns a possible side effect. Reconcile the recorded Tool Task and Git
registration using the captured source, managed path, shared Git identity, and
base commit. Missing or mismatched evidence retains the resource and reports
failure; it never guesses a new base or consults the current Project catalog.

Every managed path is containment-checked. Cleanup never targets the source
checkout, an unknown path, or a user branch. Active and pinned worktrees remain.
For older unpinned terminal, omitted, or pre-Turn-failed runs, the host writes a
binary Git patch against the captured base commit under the managed snapshot
root, including committed and uncommitted changes. Snapshot metadata is durably
stored before the registered worktree is removed; `removedAt` is stored
afterward. Ignored content and embedded repositories are not representable in
that patch, so their presence blocks cleanup and leaves the worktree intact.
Cleanup revalidates those conditions and refreshes the durable patch immediately
before removal, including when resuming a previously persisted snapshot. Pending
dispatch recovery revalidates the persisted source, managed path, registration,
and captured base commit. A crash or any failed step resumes without using or
removing an unrecorded or unrecognized worktree. Cleanup and pin state refer to
the recorded managed resource, even if the definition's hint changed or its
Project was deleted. Cleanup side effects run through Tool Tasks and append
resource receipts; they do not mutate the dispatch snapshot. An existing-Thread
run cannot keep an isolated resource alive by treating it as a Thread directory.

## Project Deletion And Reactivation

Project deletion fences claim creation, hint edits, resume, and reactivation
using the same scheduler lifecycle ordering. It reconciles pending claims with
accepted Turns before checking references. Deletion is refused while any active
or paused definition has a Project-source hint naming that Project, or while a
genuinely pending claim still names it, even if the definition is completed or
has since removed the hint. Resolving or omitting that claim removes its fence.
Standalone directory hints do not create Project references merely because
their paths match a saved Project root.

Otherwise deletion detaches catalog membership while preserving run snapshots,
active Tool Tasks, and managed-resource ownership. Historical runs with terminal
Turns, and failed/omitted claims, are self-contained and cannot dispatch again.
A previously accepted
Turn may still complete and recover its routing link using its original
snapshot; that is reconciliation, not a new occurrence. A completed definition
may remain readable with an unavailable Project hint. Direct resume stays
invalid, and an edit that reactivates it must replace/remove missing hints or
fail validation before persistence. Saved historical root values are never
fallback input for reactivation.

Startup respects the durable Project deletion fence before scheduler wakes.
Incomplete deletion retries the reference check and membership detach; it
cannot reopen admission from an in-memory catalog cache. History and worktree
cleanup load their recorded references without requiring a surviving Project.

## Execution-Context Verification

The protocol cut updates Automation DTOs/codecs, definition validation, scheduler
storage, dispatch, continuity, worktree preparation/cleanup, and renderer
projections in one change. It must cover:

| Scenario | Required result |
| --- | --- |
| No hint, directory hint, Project hint | One explicit scheduling slot per effective hint; dispatch records requested and freshly resolved addresses. |
| Reorder or edit a hint while a run is active | Stable slot ID and overlap behavior; old dispatch remains immutable; new occurrences use new captured hints. |
| Remove/re-add hint, change schedule, pause/resume | Retired IDs are not reused; old pending claims reconcile/omit; cursors do not duplicate occurrences. |
| Start now retry and restart at Turn acceptance | One occurrence claim and one accepted Turn via the original request and run IDs. |
| Symlink changes between occurrences or during prepared recovery | A new occurrence records fresh resolution; the prepared occurrence fails identity validation without redirection. |
| Existing Thread executes another directory | Its history/configuration persist; each Tool Task records its own address without a Thread-directory reader. |
| Discovery pending, failed, or restarted | A durable initial snapshot exists; successor observations do not rewrite the dispatch or task receipt. |
| Project deletion versus active, paused, completed, pending, and removed-hint definitions | Dependency fence covers all dispatchable references; completed history remains readable; reactivation validates current hints. |
| Crash before/after worktree preparation or cleanup | Captured intent/resource identity is used; current catalog paths cannot become cleanup targets. |
| Hint resolves to another checkout | Recent-run entries preserve their own dispatch context and visibly distinguish different-context evidence. |
| Retry/replay after an earlier run changes | Reuses admitted automation_info and recentRuns bytes; new dispatches may capture a new digest. |
| Existing-Thread and standalone context | Existing-Thread input appends with unchanged affinity; a new Thread receives its own complete baseline. |
| Late discovery and compaction | Uses the consuming Turn's publication boundary and scoped checkpoint; no earlier dispatch reminder is rewritten. |

The implementation replaces the old assumptions in
`tests/core/agentAutomations.test.ts`: `persists the canonical real path for a
context hint`, `rejects worktree execution for an existing Thread
destination`, and `rejects a saved project path redirected through a symlink`.
Retain their boundary coverage with fresh-per-occurrence resolution,
task-enforced isolation, and prepared-dispatch drift rejection respectively.
Extend `tests/core/agentAutomationTool.test.ts` and renderer Automation tests
for hint identity and the final strict schema. These are implementation tests;
the design PR's checks do not establish the new runtime behavior.

## Transport And Renderer

Automation uses one typed request channel and one notification channel, separate
from Agent Core history transport because definitions and run claims are not
Core entities. Methods cover list/read/create/update/pause/resume/delete,
Start now, run list/read, read state, and worktree pin state. Preload decodes every
response and notification before renderer state changes.

The model-facing `automation_update` tool manages definitions only.
Creating, updating, or reading a definition never verifies an AutomationRun,
and a completed finite definition means that its recurrence is exhausted rather
than proving a Turn result. When a user asks to test the workflow, the model runs
that workflow in the current Turn before scheduling it. It never waits for a
future occurrence with shell sleep or polling. Start now and Run inspection are
explicit Automations UI operations backed by the Run and Thread APIs.

The Automations surface is a peer of the Thread surface and is opened from the
Agent Dock header. The anchored Thread list contains only Thread navigation and
management, so Automation is never presented as a Thread-list action. The
surface is loaded as a separate React chunk so the default Thread composer does
not pay its editor and schedule cost. Its main surface is a compact searchable
list with status filters, next occurrence, and unread state. Search and New share
one aligned toolbar row; the equal-width status filter and list rows use the same
reading column, while row hover fills use the rail's concentric `--rail-pad`
boundary. Each row presents status as compact text aligned with its title;
unread state sits on the row's leading icon instead of competing with the status
slot. The selected status filter uses a stronger neutral fill and label weight.
Previous-run rows likewise reserve one in-row leading slot for unread state and
express execution state as text, never as a second adjacent dot. Selecting an
Automation, or creating one, opens the same modal bottom drawer over the list.
The drawer is bottom-aligned,
defaults to 80% height with a 52px top gap, keeps a 360px minimum where the
viewport permits, supports pointer and Arrow Up/Down resizing, and persists its
normalized height as a best-effort renderer preference.

The drawer is the sole create/detail/edit surface. Existing fields are directly
editable as one local draft, with an atomic Save/Cancel footer and discard
confirmation before a dirty draft closes. Its header keeps the Automation name
and a plain-text status visible while the form scrolls; status never uses a
decorative dot. Name and Prompt use the shared form-control skin. Details and
Frequency follow the grouped-row contract with the comfortable row-height token,
`--radius-md`, an inset hairline, content-aligned separators, and row-owned
keyboard focus. Its reading order follows the task rather than the storage schema:
name and prompt; a grouped Details table for destination, project, model, and
reasoning; a grouped Frequency table whose
conditional rows expose the complete preset (date and time for once, no
additional value for hourly, time for daily and weekdays, or multiple weekdays
and time for weekly), followed by timezone; then previous runs. Custom is a
structured rule builder rather than a protocol text field: it supports hourly,
daily, weekly, monthly, and yearly frequency,
interval, multi-select weekdays, month, multi-select month days, minute past the
hour, and time as applicable. Every renderer schedule is compiled to and opened
from the same canonical RRULE.
An existing canonical rule outside the structured subset remains the unchanged
schedule source while the user edits non-schedule fields. The first schedule-field
edit deliberately replaces it with the visible structured definition, so editing
an Automation never rewrites hidden recurrence semantics accidentally.
Model choices come from the currently usable provider catalog and atomically set
the provider-qualified model selection; timezone choices come from the runtime's
supported IANA timezone catalog. Once reuses the Outliner calendar popover for
date selection, including its month navigation, keyboard model, and Today action.
Every schedule time field reuses the shared tokenized Time Picker, which supports
direct `HH:mm` entry and complete hour/minute selection with keyboard navigation.
Its fixed-height hour and minute wheels expose seven centered values without a
visible scrollbar and support pointer, wheel/trackpad, and keyboard selection;
weekday and month-day selectors are multi-select menus that cannot be emptied.
Start now, pause/resume, delete, and worktree pinning operate through their canonical
commands rather than form mutation. `pending` and `dispatched` are presented as
Pending and Started rather than exposing scheduler jargon. A pending reserved
standalone Thread is not navigable until its Turn is dispatched.
Previous runs expose one conditional Mark all as read action in the section
header. Opening a navigable run marks it read automatically; individual run rows
never carry a read-management action. Mark all as read is one host-side update
over every unread dispatched or failed Run for the Automation, independent of
the renderer's bounded recent-run page, and publishes one bounded aggregate
notification for all open renderer surfaces. Every Run insert and mutation gets
a durable, server-side monotonic event sequence. The aggregate notification
carries the sequence assigned to the bulk update, so renderer surfaces only
normalize older Run projections. A pending Run that dispatches or fails after
the update remains unread even when both changes share the same wall-clock
millisecond.

Renderer state stores canonical Automation and AutomationRun DTOs. Realtime
notifications are merged monotonically with an in-flight initial read, including
delete tombstones, so an old response cannot undo a pause, completion, run
transition, or delete. The surface never renders a copied transcript or Issue
activity model. List unread state is queried per Automation rather than inferred
from a globally capped run page, and opening the drawer loads that Automation's
own recent run page. Selecting a dispatched run closes the drawer and opens its
canonical Thread/Turn. There are no local substitutes for ChatGPT cloud
Suggestions or Automation-level notification settings.

The Automation editor can select a saved Project or enter a standalone directory
for each context hint. A Project without a directory is disabled. A removed Project
remains visibly unavailable on a completed definition; editing its source preserves
the scheduling slot ID. Historical roots are never copied into a reactivation.

## Replacement Boundary

This is the only scheduled-agent-work implementation. Active source, tests, and
specs contain no prior recurring-Issue type, scheduled session entity, Issue
trigger, command-Node agent schedule, alternate execution scheduler, legacy store, migration,
alias, reader, or dual-write path. Generic document date values do not dispatch
agent work.
