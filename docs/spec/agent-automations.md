# Scheduled Tasks

Scheduled tasks are Tenon's Host-owned assignments for future or repeated Agent
work. A task owns its brief, materials, time plan and result destination. A run
is an association with canonical execution; Threads, Turns, Items, Tool Tasks,
resources and published records retain their existing authority. Scheduling does
not own a second transcript, output ledger, process registry or user profile.

## Domain Model

`Automation` and `AutomationRun` remain internal owner names. The product names
are Scheduled tasks, run and result. A global control in the Agent Deck header
opens the task surface independently of the selected conversation. It adds no
Outline sidebar entry or workspace panel type. Results return to the task; authoring has
one primary Project/directory location and no conversation destination picker.

An assignment contains a UUIDv7 identity, name, durable prompt, zero or more
explicit materials, one time plan, configuration selections and a revision.
CLI creation also captures the exact originating Thread, Turn and Tool Item as
inspection references; later runs do not replay that conversation.
Materials are typed file, note or HTTP(S) URL references, required by default,
with a maximum of 32. File paths are absolute. A note must still be reachable
outside Trash. Admission checks known local availability; a required missing
reference blocks dependent work and names its repair target. Optional failures
can proceed and are included in the admitted context. Actual file/web/Outline
reads recheck their own sources. An arbitrary file or URL does not promise a
historically reproducible revision.

The work location is optional. With none selected, the common Host default is
shown in the editor and used for execution; a mutable conversation location is
never consulted. An explicit Project uses its current primary-folder owner.
Locations remain lookup inputs until execution resolves and records its actual
address. Source identity drift never silently substitutes another directory.
Isolated execution uses the existing managed-worktree owner and actual macOS
write sandbox. A directory name alone is not isolation; network access retains
its configured policy. Model and reasoning selections inherit the accepted
configuration unless explicitly chosen in Advanced.

Timing (`active`, `paused`, or exhausted), archival (`archivedAt`), execution,
source availability and attention are separate facts. Internal `completed`
means there is no future automatic occurrence; it never proves a result. An
archived assignment stays readable. Restore retains history and leaves timing
paused. Archive rejects atomically while accepted work, pending preparation or
owned background responsibilities still block it. A rejected archive leaves
both timing and the definition unchanged.

## Schedule Evaluation

One evaluator serves preview and Host execution. The accepted representation is
one floating local `DTSTART`, one RRULE, and an IANA timezone. Hourly, daily,
weekly, monthly and yearly frequencies are supported. Creation and time edits
require a possible future occurrence. Invalid calendar dates reject. Unchanged
finite timing remains intact when only the brief changes.

The saved timezone anchors wall time through travel. Missing spring-forward
times are skipped; ambiguous fall-back times execute once at their first matching
instant. A monthly date absent from a month skips that month. A UTC `UNTIL` is
an absolute instant; local `UNTIL` is a wall boundary. The editor uses the shared
calendar/time controls and previews a concrete date, time and timezone through
the Host. Save revalidates at its own reference instant.

Runs require Tenon and the required resources to be available locally. After
involuntary unavailability, repeating work coalesces to the latest missed time
and retains an explicit skipped range. Interval-complete accounting and cloud
execution are outside this contract.

A one-off missed while the Host/machine was unavailable becomes an unresolved
occurrence, with no fabricated execution. Run this time addresses that exact
occurrence; canonical Turn acceptance consumes it. Skip resolves it without
execution. Preparation alone does not clear Time passed. An ordinary Run now
is independent and does not consume that unresolved time.

A healthy timer waking slightly late executes normally. Startup, machine resume
and a forward wall-clock jump crossing the due time use the unavailable policy.
Wall time is compared with the monotonic clock to distinguish callback delay
from a jump. A backward jump cannot roll back durable occurrence cursors.
An occurrence already deferred by foreground work is ordinary queueing.

Resume advances from the resume instant and does not backfill intentionally
paused time. A consumed or past one-off is not rearmed by Resume. Run now works
while timing is paused or exhausted, with no recurrence change.

## Atomic Lifecycle Controls

`AutomationScheduler` supplies one Host ordering point for dispatch, manual
admission, edits, pause/resume, archive/restore and continuation admission.
Before modifying preparation, the Host reconciles any accepted Turn by the
original client message identity. An accepted execution keeps its brief and
resolved input snapshot even if the reply was lost.

A name or brief/material/location edit does not lose an unaccepted occurrence.
Unaccepted input is refreshed from the new revision, with preparation discarded
through the resource owner before it is rebuilt. Source changes clean only
recorded Host-managed worktrees. Time edits replace unaccepted automatic timing
from the edit instant. Pause suppresses unaccepted automatic work and leaves
manual preparation and accepted execution alone.

One foreground execution occupies a task at a time, including a live question,
a canonically linked completion Turn, or unresolved settling ownership.
Repeated Run now returns the existing run and its captured revision. A new
manual request also records that association, so repeating it after the original
run finishes cannot accidentally create a new invocation.

Every CLI mutation has a request identity. Existing-assignment mutations and
manual admission also require the inspected revision. Durable operation receipts
commit with their domain write; a lost response is retried using the same input
and identity. A changed input under an existing identity rejects. Existing
receipts reconcile before fresh-write revision preconditions. An unreadable
association blocks mutation; it never guesses that prior work did not happen.
Receipts survive restart and archival. Revision conflicts return a nonzero CLI
receipt with the current revision as structured data. Receipts contain operation associations and
accepted configuration, not execution output.
The retained Host `delete` operation also commits its tombstone, pending-run
omissions and supplied request identity atomically. Replaying that identity
returns the original deletion receipt before checking the now-archived revision;
the public CLI command remains `archive`.

## Canonical Dispatch

A run captures the assignment revision, its scheduled or manual occurrence
identity, saved brief/materials/configuration and one resolved work location.
Canonical dispatch uses `tryStartTurnIfIdle` and immutable feature provenance:
`feature: automation`, referencing the exact scheduling association. The run
stores reciprocal Thread/Turn references and immutable context payload pointers.
Prepared work is not presented as an accepted Turn.

`AutomationRun.state` records dispatch (`pending`, `dispatched`, pre-admission
failure or omission), not the delivered outcome. `ScheduledRunOwnership` proves
subsequent membership from canonical Turn provenance, delivery batch membership
and recorded Task parent relationships. It never selects the latest Thread as
an ownership shortcut. Recovery reuses the admitted client and occurrence IDs.

Configuration, tool availability, resource access and capability ceilings remain
with their existing owners. Explicit authored configuration/materials are usable;
automation-origin work retains the existing exclusion from implicit Memory
retrieval and learning. Scheduling never reads a learned profile directly or
promotes previous generated output into user preference evidence.

## Results And Attention

`scheduledRunResult` rebuilds the presentation from canonical Turn evidence.
The result identifies its exact source Turn, times, delivered answer or explicit
absence, and published record path. The bounded preview labels truncation and
links to the original process. A missing or mismatched source yields Outcome
unavailable; dispatch association and read markers cannot preserve a Delivered
badge. Optional record/update inspection failure does not invent execution failure
or erase surviving original evidence.

Later delivery remains an update to its original run. It does not reorder that
run ahead of a more recently admitted invocation. Run lists use an immutable
monotonic creation sequence with identity cursors, independent of wall-clock
movement and read markers. Earlier runs can page beyond the first window.

Task summaries count unresolved causes across retained runs, including older
failures and missed one-off decisions, independently of the visible result page.
Needs attention filters tasks with a cause; it is not an unread filter. Opening
a delivered result marks it read without acknowledging its issue. Acknowledgement
names the exact issue key and changes attention only. A later different cause
remains new attention; an update in the same run does not hide an older failed
Turn. Every retained issue keeps its own exact key and acknowledgement. Runtime
ownership fences and outcome evidence stay intact.

Questions render through `UserInputRequest` and the existing `ThreadUserInputState`.
The shared Host owns deadlines, ordered settlement and answerability. Expiry
closes only that live form and resumes the same Turn; it is not run completion,
approval, a new occurrence or a release of the foreground slot. Unsent text stays
in the shared session-local draft recovery entry. Late settlement cannot clear a
newer question or another run's issue. Scheduling has no independent input timer
or answer ledger.

Discuss result creates an ordinary user conversation and stages an untrusted
reference to the exact task/run/Turn/record on its normal composer. It does not
automatically send a message or change future task instructions. Unavailable
records retain their availability and existing file/discovery restrictions.

Question and failure transitions also use native desktop notifications under
operating-system notification preferences. The Host deduplicates their canonical
cause keys, emits no successful-completion notifications, and treats delivery as
best effort. Clicking a notice opens the corresponding task workspace. There are
no task-local notification settings.

## Background Work And Handoff

The result can coexist with live background work. The shared Tool Task strip
provides factual status, bounded logs and explicit process Stop through the
canonical owner. Process observation is not readiness or final-delivery proof.
Ordinary Stop run addresses active execution; it does not implicitly stop a
service that survived a delivered result. An addressed process Stop first proves
its membership in that exact run, including canonical parent relationships.
Caller-supplied Thread IDs and unrelated Task IDs confer no access.

Late Task settlement can request a completion Turn through the existing delivery
owner. The scheduling admission hook acquires the same foreground slot before
that Turn begins. If another run occupies it, the Task owner retains its pending
work. There is no second delivery queue. Its original batch identity, cancellation
guard, configuration activation and resource ownership remain authoritative.
An uncertain live process retains the generic settling fence.

## Agent Interface

Automatic continuity contains record pointers and revision/location/material
differences, never copied generated text. It selects the latest eligible delivered
result plus bounded unacknowledged issue references across the same task. Both
selection and completion time use the canonical result projection, including
run-owned Task completion Turns. A later successful delivery does not dismiss an
older unacknowledged failure. Record access resolves before inspecting either the
initial or completion Turns; an unavailable source remains a reference with
unknown outcome and cannot supply a delivered result. CLI
result, stop and acknowledgement receipts likewise omit source text and preserve
explicit content availability; content reads follow shared record/file access.

The built-in `scheduling` Skill is discovered and loaded on demand. The packaged
`schedule` executable is a short-lived foreground Bash client. `automation_update`
is removed; no replacement scheduling model tool enters the default catalog.
The Skill, public command definitions, versioned JSON schemas and executable
validation share the scheduling contract. `schedule schema` is diagnostic help,
not a required preflight ceremony.

Read commands are list/show, runs/result, and processes. Mutation commands are
create/update, pause/resume, run/skip, stop, acknowledge, archive/restore. Mutations
use `--input - --output json`, with literal JSON in Bash's separate stdin field.
Read commands use `--output json`; list and runs expose compact references and
bounded identity cursors. Show reads the complete saved assignment. Run receipts
name the request and captured revision and distinguish waiting, accepted, blocked
and already-running admission. Result issue pages are bounded and name omitted
counts; source text is never a CLI result payload.
The complete executable contract is returned by `schedule schema`.

The existing private-descriptor capability broker binds each invocation to its
actual Thread, Turn, Tool Item, supervised Task nonce, command, stdin and process.
It does not route scheduling through delegation Session operations. The public
launcher is diagnostic-only and cannot mint authority. Standalone terminal and
remote administration are outside scope.

Host admission preserves `agent.automation.manage`, current Bash capability,
source eligibility and actual isolation. A nonce-authenticated invocation stays
eligible during a supervisor-observation delay; a stop provenance, teardown or
settlement state revokes that admission instead. Scoped/delegated invocations do not gain
management or cross-task discovery by knowing a path. The Host rechecks authority
after waiting and before an unaccepted mutation commits. Once accepted, stopping
the short-lived CLI does not undo the Host-owned assignment or run. Revision
conflicts preserve the intended change for deliberate comparison and retry.

## Project Deletion And Reactivation

Project deletion uses the same scheduling lifecycle ordering. Live enabled or
paused assignments and unaccepted preparations that name a Project fence its
removal. Historical accepted runs keep their captured Project and resource
identities; they do not turn a historical root into a new execution address.
An archived definition does not keep a live scheduling claim, and restoration
alone does not validate or execute its historical sources. Resume and Run now
validate the current explicit location through the Project owner. A missing or
redirected primary folder requires an explicit repair; no fallback path is used.
Managed-worktree cleanup continues to use recorded ownership and never removes
user-managed source folders.

## Renderer And Persistence

The Agent Deck task surface has a compact task list and result-first detail.
Below 720 logical Deck pixels it uses list/detail navigation while keeping both
surfaces mounted. Switching back to conversations or collapsing the Deck retains
task/run selection, filters, scroll, unfinished task edits and conversation drafts. Hidden task views do
not mark results read or fetch result updates; reopening reconciles current facts.
Native task notices open the exact assignment in the Deck. Discuss result returns
to an ordinary conversation with an explicit result reference, staged after that
exact conversation's composer initializes so mounting cannot clear the handoff.
View process uses
the shared Agent Trajectory inspector without replacing the task surface.
Create/edit uses a modal sheet with shared focus trapping and restoration.
Dirty close requires explicit discard. Live result updates do not replace the
form draft. A successful local pause updates the editor's base revision while
retaining its draft; an unrelated external edit still conflicts. Save submits
only definition fields, never copied run or attention state.

The typed Automation request/notification bridge remains separate from Agent
history transport. Preload decodes responses and notifications. Renderer merge
ordering retains canonical revisions and monotonic run event sequences, including
read-marker transitions. The task view is loaded on demand inside the Deck;
opening it does not navigate, split or change Outline panes.

`agent/scheduled-tasks.sqlite` is the scheduling owner. This pre-release format
cut includes explicit materials, missed occurrences, operation receipts and exact
issue acknowledgements. It has no old-format reader, migration or dual-write
path. The old scheduling database is not imported. Development and native tests
use isolated userData; production data is never a development target. Project,
Thread and resource retirement continue through their existing owners.

The focused checks are scheduling timing/receipt fixtures, canonical ownership
and unavailable-evidence fixtures, CLI admission/schema checks, the workspace
E2E suite, and the real-Electron scheduled-work smoke. The native smoke runs the
actual broker, supervised CLI, persistence and Turn lifecycle against a local
scripted provider, including restart idempotency; it does not certify any vendor's
model behavior or cloud execution.
