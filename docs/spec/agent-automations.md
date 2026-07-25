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
- zero or more stable project bindings whose saved `cwd` is a canonical real
  path, using `local` or `worktree` execution
- optional Configuration Profile, provider, model, reasoning, tool, Skill,
  Plugin, and MCP server selections
- `active`, `paused`, or `completed` status and timestamps

The accepted schedule form contains exactly one floating local `DTSTART` and one
RRULE. Hourly, daily, weekly, monthly, and yearly frequencies are supported.
Local wall time remains stable across timezone offset changes. A nonexistent
spring-forward wall time is skipped; an ambiguous fall-back wall time runs once
at its first matching instant. A UTC `UNTIL` remains an absolute instant and is
checked after converting each wall occurrence; a local `UNTIL` remains a wall
boundary. The renderer's Once, Hourly, Daily, Weekly, and Custom controls all
produce this same representation.

An `AutomationRun` is a narrow scheduling and routing record. It captures the
Automation revision, scheduled instant, one project binding, complete saved
definition and configuration-selection snapshot, optional worktree, reciprocal
Thread/Turn IDs, read state, and pin state. Main resolves the effective provider,
model, and capability configuration from that snapshot at dispatch and fails
closed when current dependencies cannot satisfy it. The run does not copy model
output, Turn status, Goal status, tool history, or errors that occur after Turn
admission.

Run routing states are:

- `pending`: the occurrence is durably claimed but has no accepted Turn
- `dispatched`: the canonical Turn was accepted and reciprocal provenance is
  durable
- `failed`: dispatch failed before a Turn existed
- `omitted`: the occurrence was superseded by catch-up, overlap, pause, or delete

Omitted occurrences use one bounded `{ from, through, count, reason }` audit
record per contiguous batch. Aggregation never crosses an intervening successful
run or an Automation revision.

## Scheduling And Durability

`AutomationStore` owns `<userData>/agent/automations.sqlite`. Definitions,
per-binding evaluated-through cursors, overlap deferrals, and run claims commit
with SQLite WAL and full synchronous durability. A unique
`(automationId, scheduledFor, projectBindingKey)` key prevents duplicate
occurrences. Standalone claims reserve their UUIDv7 Thread identity before any
Thread side effect.

The Electron main process owns one `AutomationScheduler`. It starts after
Thread and Memory recovery, wakes for the nearest active schedule, retries
pending dispatches, wakes when the machine resumes, and stops before Agent stores
close. Timer failures report an error and retain a future wake instead of
silently disabling scheduling. Automations run only while the desktop app and
required local machine resources are available.

Startup reconciles all pending claims and dispatched provenance bindings without
a renderer pagination cap before calculating new work. Across an offline
interval, each Automation/project binding claims only the latest missed
occurrence and stores older ones as one `catchUp` omission. While one occurrence
is active, later due work is persistently marked as overlap-deferred. When the
active Turn becomes terminal, only the latest deferred occurrence starts and
older due work becomes an `overlap` omission. One active occurrence per
Automation/project binding is therefore enforced across normal wakes, Start now,
and restart.

Create, update, pause, resume, delete, Start now, worktree pinning, scheduled
admission, and worktree cleanup share the scheduler mutex. Revision preconditions
reject stale edits. Before pause or delete classifies a pending claim, the host
looks up its `clientUserMessageId` binding and durably restores any already
accepted Turn as `dispatched`. Pause and delete then atomically convert only
genuinely undispatched claims to omissions; an already dispatched Turn continues
as canonical history, and a paused or completed definition cannot Start now.
Delete tombstones the definition so run snapshot and foreign-key history remain
intact. Any finite RRULE definition becomes
completed after every project binding has durably claimed its final occurrence.
Changing a completed definition's schedule reactivates it from the edit time;
other edits preserve its completed state.

Start now uses the saved definition and same durable claim/dispatch path. It does
not bypass no-overlap, dependency validation, worktree preparation, tool
selection, or explicit capability blocks.

## Canonical Dispatch

A standalone occurrence creates one persistent root Thread per project binding
with `threadSource` classified as feature `automation`. It uses the Automation
name, captured configuration, and prepared working directory. Its composer is
read-only because only the host feature path may add Turns.

An existing-Thread occurrence adds a Turn to one active persistent root user
Thread and preserves that Thread's history, provider, Goal, and working context.
It accepts at most one local project binding, whose real path must match the
Thread workspace; worktree mode is invalid because an existing Thread has one
sticky cwd. A busy Thread leaves the claim pending until the same single-Turn
coordinator becomes idle.

Both destinations call the privileged `ThreadService` feature admission with
`clientUserMessageId=AutomationRun.id`. Retrying after a crash therefore returns
the already accepted Turn instead of appending another. Every dispatch attempt
performs this lookup before project/worktree preparation and configuration
resolution; failure finalization repeats it and leaves the claim pending if the
reciprocal run binding cannot yet be committed. Before model execution,
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
run, revision, scheduled time, destination, canonical execution cwd, project,
and worktree facts.
This application context helps the model but is not provenance, a ThreadItem, or
renderer-authored input.

Automations never create a parallel Goal. A Turn in an existing Thread is
observed by that Thread's current Goal extension normally. Automation-triggered
Turns are ineligible for implicit Memory extraction, retrieval, citations, and
Memory graph mutation even when delivered to an ordinary user Thread. Memory
uses immutable Turn provenance rather than Thread source or prompt text for this
decision.

## Configuration And Authority

Each claim stores the exact Automation definition revision. At dispatch, the
host resolves its saved Profile and explicit overrides against the current
provider, model catalog, tool catalog, Skill catalog, Plugin registry, and MCP
server catalog. Create and update reject invalid current selections before
persistence; dispatch repeats the resolution because catalogs and credentials
may change before a future occurrence. Missing or disabled selected dependencies
fail before Turn admission. An existing-Thread destination rejects explicit
choices that differ from its effective persisted configuration both when saved
and when dispatched. Capability selections retain three distinct values:
`null` inherits the Profile, `[]` explicitly disables the capability class, and
a non-empty list is the exact allowlist. For Automation Turns, the effective
Skill allowlist filters both model-visible Skill listings and runtime invocation;
disabled or non-model-invocable Skills are absent from dispatch validation.

Creating or resuming an Automation is standing authorization for future
occurrences under Tenon's Full Access model. Automation introduces no sandbox,
permission profile, approval policy, or authorization prompt. Current explicit
capability blocks and native provider, operating-system, filesystem, network,
and service failures are evaluated by their existing owners. A root Automation
Turn may use `request_user_input` for missing product input; while its Turn waits,
later occurrences continue to coalesce instead of overlapping.

The root-only `codex_app.automation_update` model tool provides strict create,
update, view, and delete modes over the same service. Its schema and runtime
decoder reject unknown fields, invalid UUIDv7 identities, empty updates,
unsupported schedules, and inputs beyond the shared length/count bounds. It is
subject to the `agent.automation.manage` capability action like every other
model tool.

## Projects And Worktrees

No-project runs use the agent local-file root. Create and update resolve each
project directory through `realpath` and persist that canonical path; dispatch
requires a fresh `realpath` to equal the stored path exactly, preventing a saved
location from being redirected through a later symlink. Worktree mode also
requires the fresh Git top-level to equal that same stored root and creates a
detached worktree at the captured source `HEAD` under the app-owned
`<userData>/agent/automation-worktrees/` tree.

Every managed path is containment-checked. Cleanup never targets the source
checkout, an unknown path, or a user branch. Active and pinned worktrees remain.
For older unpinned terminal, omitted, or pre-Turn-failed runs, the host writes a
binary Git patch against the captured base commit under the managed snapshot
root, including committed and uncommitted changes. Snapshot metadata is durably
stored before the registered worktree is removed; `removedAt` is stored
afterward. Pending dispatch recovery revalidates the persisted source, managed
path, registration, and captured base commit. A crash or any failed step resumes
without using or removing an unrecorded or unrecognized worktree.

## Transport And Renderer

Automation uses one typed request channel and one notification channel, separate
from Agent Core history transport because definitions and run claims are not
Core entities. Methods cover list/read/create/update/pause/resume/delete,
Start now, run list/read, read state, and worktree pin state. Preload decodes every
response and notification before renderer state changes.

The Automations surface is opened from the anchored Thread list. It is loaded as
a separate React chunk so the default Thread composer does not pay its editor and
schedule cost. Its main surface is a compact searchable list with status filters,
next occurrence, and unread state. Selecting an Automation, or creating one,
opens the same modal bottom drawer over the list. The drawer is bottom-aligned,
defaults to 80% height with a 52px top gap, keeps a 360px minimum where the
viewport permits, supports pointer and Arrow Up/Down resizing, and persists its
normalized height as a best-effort renderer preference.

The drawer is the sole create/detail/edit surface. Existing fields are directly
editable as one local draft, with an atomic Save/Cancel footer and discard
confirmation before a dirty draft closes. Its information order is status and
actions; name and prompt; execution details; frequency; advanced capabilities;
then previous runs. Capability controls preserve inherit (`null`), explicitly
none (`[]`), and exact allowlist states. Start now, pause/resume, delete, and
worktree pinning operate through their canonical commands rather than form
mutation. `pending` and `dispatched` are presented as Pending and Started rather
than exposing scheduler jargon. A pending reserved standalone Thread is not
navigable until its Turn is dispatched.

Renderer state stores canonical Automation and AutomationRun DTOs. Realtime
notifications are merged monotonically with an in-flight initial read, including
delete tombstones, so an old response cannot undo a pause, completion, run
transition, or delete. The surface never renders a copied transcript or Issue
activity model. List unread state is queried per Automation rather than inferred
from a globally capped run page, and opening the drawer loads that Automation's
own recent run page. Selecting a dispatched run closes the drawer and opens its
canonical Thread/Turn. There are no local substitutes for ChatGPT cloud
Suggestions or Automation-level notification settings.

## Replacement Boundary

This is the only scheduled-agent-work implementation. Active source, tests, and
specs contain no prior recurring-Issue type, scheduled session entity, Issue
trigger, command-Node agent schedule, alternate execution scheduler, legacy store, migration,
alias, reader, or dual-write path. Generic document date values do not dispatch
agent work.
