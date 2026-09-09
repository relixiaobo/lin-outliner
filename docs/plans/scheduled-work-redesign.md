# Scheduled Work: Assignment, Delivery, and Handoff

## Goal

### Purpose and target user

Give a person one enduring place to entrust future work to Tenon, inspect what
was delivered, and take over when needed. The primary user already works with
Agent conversations, notes, and local materials and wants a periodic check,
summary, organization task, or one future execution.

**OBJ-1:** A person can state the work, choose its timing and materials, leave,
and return to an understandable result or an actionable exception.

**OBJ-2:** The person can distinguish the plan, an individual execution, and a
background process without understanding the execution transport.

**OBJ-3:** Agent access uses ordinary Bash plus an on-demand Skill. Scheduled
work contributes no dedicated model tool to the default catalog.

**Minimum acceptable outcome:** Creating, executing, reviewing, changing,
pausing, manually running, stopping, and discussing one scheduled assignment
form a complete usable loop with honest unavailable and interrupted states.

## Non-goals

Cloud execution, multi-device coordination, event/webhook triggers, a visual
workflow builder, guaranteed processing of every missed interval, automatic
financial or other deadline-critical transactions, multi-project broadcast,
a second conversation or execution history, a new verification/Git framework,
task-local user profiles, or implicit global learning from generated runs.
Reminder-only work remains ordinary dated content. Permanent deletion and global
retention policy remain with the existing data owners; this feature supplies
reversible archival. No migration or historical-format reader accompanies a
pre-release format change.

## Design

### Decision summary

**Shape: (a) ONE complete feature in one implementation PR.** The product includes
the assignment surface, delivery projection, lifecycle controls, Agent access,
and all recovery/availability cases below. Internal build order creates no
separately released scaffolding. Shared interfaces follow repository ownership
and coordination rules before their consumers are implemented.

**DEC-1:** The user-facing feature is **Scheduled tasks**. A scheduled task is a
saved assignment with a time plan and a stable result destination. A **run** is
one execution of that assignment. A **result** is the run's delivered answer and
linked outputs. These terms do not introduce a generic replacement for Tool Task.

**DEC-2:** Results always return to the task. Each run has an independently
inspectable execution record. The product has no new/existing-Thread destination
picker; conversation organization is owned by the runtime.

**DEC-3:** The first release targets current-state work on the local machine.
Repeated work catches up once with current information. Every-period accounting
requires a different explicit delivery contract and is outside this feature.

**DEC-4:** Task content, timing, execution, and result attention are independent
controls. Pausing timing leaves an accepted run alone. Run now works while a plan
is paused or ended. Discussing a result leaves future instructions unchanged.

**DEC-5:** Recent platform mechanisms determine integration ownership. Previous
Automation screens, bindings, names, and transport choices do not determine the
new product interaction.

**DEC-6:** Replace `automation_update` with a packaged `schedule` CLI and a
built-in scheduling Skill. UI and CLI call the same Host-owned operations. The
CLI is a short-lived client; the Host remains the scheduler and execution owner.
The implementation retires the old tool, schema, registration, and instructions
in the same complete feature. It adds no replacement model tool.

### Constraints, alternatives, and evidence

- **CON-1, hard:** Preserve the TypeScript/Electron process boundary, native
  security defaults, canonical mutation and provenance owners, actual isolation,
  and clone/production data separation from [AGENTS.md](../../AGENTS.md).
- **CON-2, hard:** Consume shared execution, resource, configuration, and recovery
  contracts; inspection failure cannot fabricate execution failure or completion.
- **CON-3, selected product boundary:** Execution requires Tenon and the local
  resources to be available. This is a deliberate scope choice, not a claim that
  cloud execution is intrinsically impossible.
- **CON-4, inherited choices released:** Drawer-first editing, command Nodes,
  conversation destinations, project fan-out, and raw dispatch states are not
  constraints on the product design.
- **OPT-1, selected clean-slate target:** A stable assignment with result-first
  detail, independent controls, and a canonical execution record per run.
- **OPT-2, considered minimum:** A timer that posts another Agent message. It
  schedules work but leaves result discovery and exception handling with the user;
  it does not meet OBJ-1.
- **OPT-3, deferred expansion:** Every-period or always-on execution. Revisit when
  concrete work requires completeness across offline intervals or another runner.
- **OPT-4, selected Agent interface:** CLI plus Skill provides explicit operation
  receipts without keeping task-management schemas in every model context. A
  dedicated model tool would preserve another always-available domain interface;
  a watched definition file would require another saved/accepted/effective
  activation contract alongside execution commands. Neither is selected here.
- **TRD-1:** A task has one primary work location. Several explicit reference
  materials are supported. Separate locations requiring separate executions use
  separate tasks rather than a hidden fan-out multiplier.
- **TRD-2:** Each run receives a task brief and bounded continuity. A permanently
  growing conversation is not the task's memory or configuration authority.
- **EVD-1:** The user requested a clean-slate product and interaction design and
  specifically required consideration of recent related iterations.
- **EVD-2:** The integration baseline was inspected at `origin/main` commit
  `7d89e698`; the dependency audit below distinguishes implementation from plans.
- **EVD-3:** The user explicitly prefers CLI plus Skill and gradually reducing
  default tools. Existing Outline and delegation CLI/Skill paths establish the
  local packaging and Agent-invocation precedent; file-first Settings establishes
  a separate precedent for declarative preferences.
- **ASM-1:** The main demand is periodic research, review, and organization rather
  than interval-complete processing. Validate with the user's actual examples
  before implementing an additional missed-occurrence policy.
- **ASM-2:** A stable task result destination is more useful than choosing a
  destination conversation. Validate by walking through a first run, a failed
  run, and a later follow-up in the interaction prototype.

### Product objects and ownership

| User concept | Meaning | Authority |
| --- | --- | --- |
| Task brief | Name, durable instructions, explicit materials, one optional work location | Revisioned assignment owner |
| Time plan | Once or repeating, local time, timezone, enabled/paused/ended | Scheduling owner |
| Run | One accepted scheduled or manual invocation, its initiating Turn and owner-linked continuation Turns, with captured brief/source identities | Scheduling reference plus canonical execution owners |
| Result | Delivered answer, output references, availability, and links to exact process/history | Canonical Turn, Item, and resource owners; rebuildable presentation |
| Attention | A live question, failed/interrupted execution, or unresolved outcome requiring action | Exact canonical cause and lifecycle; explicit acknowledgement where applicable |
| Background process | Owned work that can remain live after the initiating Turn | Generic Tool Task owner |

Task lifecycle (available/archived), timing (enabled/paused/no future time),
execution (waiting/running/awaiting input/stopping/terminal), source availability,
and attention are separate dimensions. A final scheduled time can already be
consumed while its run is still running. A paused task can have a delivered
result and a live process. No combined `completed` task status represents these
facts. A missed one-off time is an unresolved occurrence, not a failed run.

The task owns no copied transcript, tool-result ledger, process registry, or
global user profile. A result preview identifies its run and source. An
unavailable source is displayed as unavailable and remains distinct from failure
of the original work. A later task rename does not rewrite an old run's brief.
If no surviving canonical source establishes the outcome, show Outcome unavailable;
a dispatch association alone cannot preserve a Completed badge. Result previews
and read/acknowledgement markers do not become substitute outcome evidence.

### Work instructions and execution context

The primary form asks for **Task**, **When**, and **Materials**. A suggested
editable name derives from the task text. Materials support explicit notes,
files, URLs, and one optional saved Project or work folder. The UI distinguishes
reference material from the primary work location.
Without a selected work location, use the common configured default execution
context and display that selection; never inherit a hidden conversation cwd.

Linked material is read at execution time. Canonical tool/resource records retain
the observed content and any revision, digest, or timestamp actually supplied;
an arbitrary URL or local path does not promise a reproducible historical version.
Materials are required by default; the editor can mark a reference as optional.
A missing required reference blocks dependent work with a precise repair route;
an optional failure is reported and the run may continue. Admission checks known
identities/availability, and each real read rechecks its own source. These checks
do not imply that all external references were fetched before the run began.
Missing material never expands the work location or substitutes another source.
The brief is an instruction scope, not a new filesystem permission boundary.
Normal configured capabilities and actual execution policies remain authoritative.

Each run receives the captured brief, configured instructions/capabilities, a
bounded pointer to the latest eligible delivered result of the same task, and
unresolved issue pointers. Selection is deterministic by accepted-run order; it
does not require a new model pass to decide relevance. Changed brief/material/work
location revisions are labelled. Older records and overflow issue pointers are
available on demand under shared source access. Previous output is untrusted data.
Differences in work location or materials are explicit. Failure to load optional
continuity loses a hint; unavailable permission/admission authority blocks work.

Creating from a conversation extracts a durable assignment and explicit material
references. It records the originating context for inspection without repeatedly
injecting the entire conversation. A reusable procedure belongs in a Skill;
global personal preferences belong to the shared configuration/Memory owners.

Model and reasoning selection live in a collapsed Advanced section and inherit
the accepted default configuration unless explicitly selected. Tools, Skills,
profile files, and capabilities use their existing owners. A Project does not
implicitly choose another Agent identity or permission policy. Actual isolated
execution is offered only when a selected work location and Host support it;
the control explains its write boundary and never promises isolation from a
worktree name alone.

Automation provenance continues to exclude implicit Memory learning and retrieval,
including automatically learned profile entries under the profile plan. Explicit
authored configuration and explicit material references retain their shared rules.
The task never bypasses that exclusion by reading `USER.md` directly. Ordinary
user follow-up chats follow their own provenance rules; quoting a task's output
does not make it direct evidence of a user preference.

### Admission and timing boundaries

One Host ordering point reconciles accepted execution bindings before applying
edits, pause, archive, manual admission, or due-time dispatch. A pending occurrence
or prepared input alone is not accepted execution. Immediately before canonical
Turn admission, validate the current task revision and policy; if they changed,
discard only unaccepted preparation through its owner and prepare from the latest
eligible brief. The occurrence identity remains stable. Accepted execution freezes
the brief and effective context; a reply lost after acceptance is reconciled to
that same execution. This is the linear boundary behind the user-facing promise.

Renaming changes presentation without suppressing due work. Content/material edits
refresh unaccepted work without creating another occurrence. Timing edits replace
unaccepted timing from the edit instant and expose any superseded occurrence;
pause suppresses only unaccepted automatic work. Already accepted manual or timed
runs keep their captured inputs and occupy the task's foreground slot. Ending a
schedule means no future automatic time; it never certifies a run's outcome.

Late Tool Task settlement updates the original run's resource facts. If shared
delivery needs another Agent Turn, it retains the canonical delivery-batch and
source-Task relationship to that original run. It must acquire the same task's
foreground admission slot before executing; while another run occupies it, the
existing delivery owner keeps its pending work. Pure observations need no slot.
This is an admission integration, not a second delivery queue or guessed
latest-Thread association. Stop/cancellation fences from the shared owner still
apply, and archive cannot strand pending continuations. Later output is labelled
as an update to its original run; it does not reorder earlier runs ahead of a
more recently admitted invocation or mutate that invocation's captured continuity.
Continuation Turns retain the original assignment and source ownership while
following the shared per-Turn configuration activation and capability ceilings;
this feature does not introduce another profile-freezing rule.

| Situation | Timing decision |
| --- | --- |
| Ordinary Run now, including while paused or ended | An independent manual invocation; it does not consume a future or missed scheduled time. |
| Missed one-off: Run this time | Explicitly fulfill that exact unresolved occurrence. Admission consumes it, so no stale Time passed prompt remains; run failure is a separate attention cause. |
| Missed one-off: Skip this time | Resolve that occurrence without execution. Editing the time instead replaces it with the newly previewed future time. |
| One-off due while another run occupies the task | Wait for the foreground slot, then admit once; this is ordinary queueing, not involuntary-offline catch-up. |
| Several repeating times become due during a run or outage | Retain only the latest unaccepted occurrence and a bounded skipped range; accepted work is never replaced. |
| Resume with no future time, including a paused one-off whose time passed | Keep No future time and offer Edit time / Run now. Resume cannot rearm a consumed or past occurrence. |
| Edit an ended plan to a valid future time | Explicitly rearm it and return its next occurrence. Editing a paused task preserves its pause; an archived task must first be restored, which leaves timing paused. |

Known Host/machine unavailability spanning the due time invokes the missed-time
rule. Normal timer callback delay while healthy does not turn every one-off into
Time passed. A forward wall-clock jump crossing due times uses the same catch-up
rule; a backward jump cannot repeat an already accepted occurrence. UI and CLI
use the same schedule evaluator, timezone, reference instant, and next-occurrence
receipt. One-off dates must be future at creation/time edit; invalid combinations
with no possible occurrence are rejected while valid sparse dates preview the
actual next time. Saving cannot report an obsolete preview as the accepted time.

### Agent access: CLI plus Skill

The Agent discovers a short scheduling Skill description through the existing
Skill catalog and loads its instructions when the user's request concerns
scheduled work. The full command contract is not injected into every Turn. The
Skill explains intent, timing, materials, revision handling, receipts, and result
handoff; executable validation and authorization stay with the Host. It neither
runs timers nor becomes a per-task storage format. One Skill manages any number
of assignments; reusable work procedures can be separate existing Skills.

The invocation path is `Agent -> scheduling Skill -> bash -> schedule CLI ->
Host task service`. Renderer actions use the preload bridge to that same service.
The CLI does not launch a second scheduler, run a provider directly, write private
stores, or install OS scheduling jobs. The application retains the local execution
promise in BR-1, even when the initiating CLI process has exited.

The proposed executable is `schedule`, kept separate from generic Tool Tasks.
Its bounded interface is:

| Command family | Meaning and result |
| --- | --- |
| `schedule list` / `schedule show TASK_ID` | Read definitions, accepted revision, readable timing, availability, and current/latest run references. Lists are paginated. |
| `schedule create` / `schedule update TASK_ID` | Atomically validate and save the assignment; return the accepted revision, next occurrence, and task reference. |
| `schedule pause TASK_ID` / `schedule resume TASK_ID` | Change automatic admission independently of editing or current execution. |
| `schedule run TASK_ID` / `schedule stop RUN_ID` | Admit a manual run or request that exact run's cancellation through its execution owner; return promptly with the real state. |
| `schedule run TASK_ID` with an exact missed-occurrence input / `schedule skip TASK_ID` | Fulfill or skip the addressed unresolved one-off occurrence. Neither accepts a stale or already resolved occurrence as new work. |
| `schedule acknowledge RUN_ID` | Acknowledge an exact terminal issue; it cannot answer a live question, change its outcome, or clear an ownership fence. |
| `schedule archive TASK_ID` / `schedule restore TASK_ID` | Apply the same reversible lifecycle checks as the UI; restoration leaves timing paused. |
| `schedule runs TASK_ID` | Page run associations, outcomes, and shared record/resource references; no copied transcript or private history query language. |
| `schedule processes RUN_ID` / `schedule stop RUN_ID` with an exact Tool Task target | Inspect a bounded live observation or stop that run's addressed background process through the shared owner. Ordinary Stop run does not implicitly stop surviving services after delivery. |

Agent mutations use canonical commands with `--input - --output json`; literal
JSON travels through the existing separate Bash stdin field. Read commands use
`--output json`. A typical creation invokes
`schedule create --input - --output json`. Long instructions never become shell
interpolation, command arguments, or environment values. Versioned schemas, CLI
help, decoding, and receipts derive from one contract. The Skill includes a
minimal valid example; `schedule schema` and `schedule doctor` diagnose actual
validation/availability failures rather than impose routine preflight calls.

Every mutation carries a request identity; edits and lifecycle changes to a
saved assignment also carry its expected revision. Repeating the same admitted
request returns its original receipt, even after a run has finished. Reusing its
identity with different input is rejected. A lost reply is reconciled using the
same identity; it never authorizes a new create/run request. The task owner keeps
the required durable operation associations, not another execution/output ledger.
Conflict returns the current revision without discarding the Agent's intended
change; the Agent reads, compares, and submits a deliberate revision.
Run admission carries the expected assignment revision too, so a reviewed brief
cannot be silently replaced between inspection and Run now. Request associations
survive restart and archive for the task's retained lifetime. Reset/deletion must
invalidate the corresponding request namespace before removing its associations;
stale requests then reject rather than become new operations. An unreadable
association owner blocks mutation instead of guessing whether an earlier call ran.
After authorizing the caller, reconcile an existing request identity before
checking fresh-write revision preconditions. A new manual request made while
another run is active returns Already running with that run's captured revision;
it never claims that the newly edited brief has executed.

Receipts distinguish saved assignment, accepted run, requested stop, and terminal
outcome. Successful `schedule run` exits after admission; it does not stay alive
until the scheduled work finishes. Stopping that short-lived CLI cannot undo an
accepted run. `schedule stop` addresses the run; surviving background processes
remain owned by generic Tool Tasks. Existing `task_status` / `task_stop` are
Thread-scoped and do not gain cross-Thread access from a returned ID. From another
user conversation, the scheduling CLI resolves an authorized task/run to its
recorded owner, verifies the exact Tool Task membership through canonical source
and delegation relationships, and routes inspection/stop to the existing service.
Caller-supplied Thread IDs, stale associations, unrelated tasks, and historical
source readability do not grant control. Renderer controls use the same resolver.
This adds no process registry or alternative stop semantics. Source content
uses the unified record files and ordinary file tools; the CLI returns pointers
and availability instead of exposing another history model tool. Skill guidance
prohibits shell sleep, background timer loops, repeated status polling, and claims
of delivery based on admission alone.

The Host binds CLI admission to the actual source Thread/Turn/Tool Task and its
effective capabilities, following the existing packaged delegation CLI pattern.
The bridge must preserve root/delegated, read-only, worktree, source-discovery,
and scoped-readiness restrictions. Merely knowing a CLI path, hiding a Skill,
or having Bash is not authorization. The implementation coordinates any shared
admission changes; it does not repurpose delegation Session commands or create
an unrestricted local management server. Disabled Skill discovery and denied
execution authority remain separate existing configuration concepts.
Preserve the existing `agent.automation.manage` action at CLI admission even
after its model-tool registration is removed. Read-only discovery also checks
the caller's actual source scope. Packaged CLI discovery supplies the executable,
version, and public contract without exposing a credential or private database.
The initial CLI serves Host-admitted Agent invocations; standalone terminal
administration and remote clients require a separate authority contract.

Task definitions remain revisioned domain data. The brief may reference files,
and a local file may be an editing draft, but writing a file alone does not
activate scheduled work. Global preferences and profile configuration continue
through their public files and configuration Skill. This selects CLI for task
operations without replacing the file-first configuration design or moving
canonical run records into task-owned files.

### Screens and interaction

**SCREEN-1: Scheduled tasks workspace.** A persistent Scheduled tasks entry in
the application sidebar opens a workspace pane. At sufficient width it has a
compact task list and task detail; below 720 logical pixels it uses list/detail
navigation with Back restoring selection and scroll. The ordinary Agent dock
remains available for discussing a result. This replaces the Automation drawer
as the primary work surface.

The list offers **All** and **Needs attention**, with **Archived** in the list
menu. Rows show name, latest result/exception, and the next planned time or paused
state. Attention count includes unresolved questions/failures/uncertain outcomes,
not every unread run. Opening a result marks that delivery read; reading alone
does not resolve its question or failure. Selection never starts execution.
Needs attention includes missed one-off decisions as well as run issues. Its
count is the number of tasks with at least one unresolved cause, not the number
of historical errors. Detail names each cause and its exact occurrence/run;
repeated equivalent terminal failures can be grouped with an affected-run count.
Acknowledgement targets the shown causes, and a later failure remains new attention.

**SCREEN-2: Task detail.** The header shows name, readable plan summary, and
**Run now**, **Pause schedule / Resume schedule**, and **Edit task**. The content
starts with the current execution/exception when present, followed by the most
recent delivered result and **Earlier runs**. Configuration is secondary.

A result shows its actual outcome and scheduled/start/finish times as relevant,
answer or explicit absence, files/notes, and **Discuss result** plus **View
process**. Earlier runs are paginated; selecting one opens that exact run and
its exact Turn position. A contextual Back returns to the task. Long content
uses the normal reader. Files preserve their canonical availability and retention.

Current execution displays its latest meaningful activity and **Stop run**.
Questions use the shared user-input interaction in place. A delivered result
with a surviving process also displays **Background work: running** with the
shared status/log and Stop process actions. One status never stands for both.
Stopping displays Stopping until the actual owner settles. The shared
[user-input lifecycle](user-input-request-recovery.md#answer-drafts-and-settlement-presentation)
owns question answerability, original deadline, and answered/timed-out/cancelled/
failed settlement. An accepted answer or a timeout closes the live form and
continues the same active Turn/run; interruption or owner failure closes/fences
it through that execution owner. Unsent answer content uses the shared renderer
recovery entry, independent of live answerability. Run termination is not required
to close an expired question. Timeout alone neither ends the run nor releases its
foreground slot, marks a result read, or dismisses another issue.

Active-question attention derives from the exact pending request, so it clears
on that request's authoritative settlement. A timeout remains inspectable as
no answer submitted; it is not a live question, user acknowledgement, or evidence
of run success/failure. Separately established unresolved-input, failure, and
uncertainty causes retain their own attention. A delayed settlement cannot clear
a newer question or another run's cause. Scheduling adds no question timer,
answer ledger, text-based outcome inference, or automatic re-ask. Generic
recovery continues to own stale questions and unknown effects.

**SCREEN-3: Create/edit sheet.** A compact modal form contains task text,
materials, and a readable time builder; Advanced is collapsed. Once, hourly,
daily, selected weekdays, monthly dates, and yearly dates share one time model.
The form always previews the next concrete local date/time and timezone. Invalid
calendar combinations either explain the next valid occurrence or reject when
none exists. Custom protocol text
is not required. Calendar and time entry reuse native-feeling shared controls.

Create validates before activation. Edit saves one revision; conflict preserves
the draft and offers comparison/reload, not last-writer-wins overwrite. Close
with dirty content offers Keep editing / Discard. Saving changes future
unaccepted work; an accepted run keeps its original brief. The edit sheet includes
a saved-plan Pause schedule action that remains usable independently of the
draft. Pausing retains the draft and updates only the saved timing state.
Save submits edited definition fields against the accepted revision, never a
stale copy of run/attention state. A successful local pause updates the editor's
base revision without overwriting its draft; unrelated external changes still
conflict. Live run updates preserve unsaved text, selection, and focus. Closing
an unchanged form needs no discard prompt. Closing a modal restores its opener.

**SCREEN-4: Result handoff.** Discuss result opens an ordinary user conversation
with an exact run/result reference and the user's question. It uses shared
reference and reading behavior, including unavailable content. Follow-up work
belongs to that conversation. An explicit request to change future instructions
updates the task through its revisioned management operation and shows a receipt.

### Flows

**FLOW-1: Create future work.** From Scheduled tasks, select New task, describe
work, add materials, choose timing, inspect the next occurrence, and select Create.
The task opens with the plan and an empty result area. The user can Run now using
that saved brief without changing the planned occurrence. Validation/save failure
retains the form and points to the field or shared configuration repair action.

**FLOW-2: Schedule from conversation.** An explicit, sufficiently specified user
instruction creates the task and returns a compact receipt with the saved brief,
next occurrence, and Open task / Pause schedule. An Agent suggestion remains a
proposal with Create task. Missing product information is clarified before
activation; no extra permission ceremony is introduced by this feature.
The Agent uses the scheduling Skill and CLI; the user need not see commands or
manage files. Only an acceptance receipt supports a success claim. A missing
reply leaves the outcome unresolved until reconciled; a conflict preserves the
intended change without applying it.

**FLOW-3: Return to results.** Open Scheduled tasks, choose a task, read its latest
delivery, follow an artifact or exact process reference, and optionally discuss
the result. A run with no changes says so only when the execution actually
reported that finding. Empty output is not interpreted as no changes or success.

**FLOW-4: Handle an exception.** Needs attention opens the exact run. Answer a
live question, repair a missing dependency, inspect an uncertain side effect,
run again explicitly, or acknowledge a terminal failure. Acknowledgement changes
attention only. It never retries execution, fabricates success, or clears a
runtime ownership fence. Repair uses the original owner and reports its result.
If the shared question deadline elapses first, show its no-answer outcome and
remove only that live-question cause. Retained unsent text remains recoverable
through the shared composer flow; it is not sent into the expired tool. The
existing run keeps executing, and a late reply cannot admit another occurrence.

**FLOW-5: Change or end the arrangement.** Edit affects future accepted runs;
Pause affects future automatic admission; Run now is independent; Stop run
targets current execution. Archive is reversible after active work has settled.
If owned background work remains, resolve or explicitly retain it through its
owner before archive; archived task references still expose retained resources.
Archive is an atomic operation that rejects while accepted work still blocks it;
a failed archive leaves the task and timing unchanged. Archived detail is readable,
offers Restore, and cannot Run now or Resume. Restore preserves history and leaves
timing paused; it does not start a run. A terminal-run acknowledgement is available
through UI and CLI. Live questions use the existing user-input owner.
Definition edits also require restoration; both entry paths enforce this rule.

### Business rules and failure recovery

| Rule | Observable behavior |
| --- | --- |
| BR-1: Execution promise | Runs require Tenon and required resources to be available. The time builder and unavailable surface state this local execution condition. |
| BR-2: Repeated catch-up | After involuntary unavailability, run current-state work once for the latest missed occurrence. Older missed times form a visible skipped range. |
| BR-3: One-off missed time | If Tenon was unavailable at the one-off time and did not accept that run, show Time passed with Run this time / Skip this time. Either action resolves that exact occurrence; ordinary Run now remains a separate manual invocation. |
| BR-4: Intentional pause | Resume schedules future occurrences from resume time. The intentionally paused interval is not backfilled. Run now remains available while paused or ended. |
| BR-5: Concurrent work | One foreground execution per task; live questions and unsettled foreground work occupy it. Answer/timeout resumes that same execution without releasing its slot. Further repeated times coalesce. Repeated Run now activation returns the existing active run. |
| BR-6: Background lifecycle | Explicit background processes use generic Task ownership and can outlive result delivery. Their liveness is visible separately. They do not by themselves hold the foreground slot forever or authorize replacing an existing service. |
| BR-7: Delivery truth | Dispatch acceptance, a running log observation, Turn termination, and verified requested outcome are distinct facts. Missing/partial output retains successful canonical operations and shows bounded omission. |
| BR-8: Recovery and retry | Service Retry restores owner readiness and reconciles admitted work. Run again creates a new invocation. Unknown effects or process ownership block unsafe replay; the UI links to recorded effects and the existing recovery owner. |
| BR-9: Timing versus execution | Pause does not cancel accepted work. Manual execution does not advance recurrence or reactivate an ended plan. Stopping is nonterminal until its owning processes/tasks settle or report uncertainty. |
| BR-10: Edits | Canonical acceptance freezes execution inputs. Name-only edits do not cancel due work; content edits refresh unaccepted preparation. Timing changes replace unaccepted timing and report the next occurrence. UI draft saves never overwrite live run state. |
| BR-11: Attention | Live questions, failures, missed one-off decisions, empty expected terminal delivery, and unresolved outcomes remain actionable. A shared request settlement removes only that live-question cause; timeout remains factual no-answer history, with unsent draft recovery. Unread results and separately established issues are independent. Starting or completing another run never dismisses an older unresolved issue. |
| BR-12: Notices | Persist results in the task. Use existing native-notification preferences for new questions/failures; deduplicate each attention transition. No per-task notification settings or completion-notification storm. |
| BR-13: Time semantics | A saved IANA timezone anchors local wall time. Travel does not silently move it. Skip nonexistent DST times, run ambiguous times once, and preview the next actual occurrence. Monthly dates absent from a month skip that month. |
| BR-14: Scope and history | Task archive, conversation removal, Project removal, and resource expiry follow their own ownership. Unavailable old records remain labelled; future work depends on current explicit material, not hidden historical aliases. |
| BR-15: Ordinary failure | A known terminal failure raises attention without changing the enabled plan. Future runs follow timing after required admission becomes available. Uncertain side effects retain the stronger generic recovery fence. |
| BR-16: Agent interface | UI and CLI share validation, revisions, and lifecycle owners. Skill text is guidance, never executable authority. No dedicated scheduling model tool remains. |
| BR-17: Command settlement | A command receipt identifies the operation it proves. Lost replies and repeated request identities do not duplicate mutations or runs; cancellation after admission uses the actual run owner. |

Empty lists explain New task; empty results show the next occurrence and Run now.
Loading does not masquerade as no tasks. An unavailable task owner shows the
scoped startup issue and Retry/healthy-feature navigation, preserving any known
task data. An unavailable history source leaves other tasks and future admission
usable when their owning authorities remain valid. Delete/Reset are never error
fallbacks. Permission, model, and source failures use the existing repair owner.

### Requirements and acceptance criteria

**FR-1:** Create and edit one durable assignment from the form or an explicit
Agent instruction; preserve revision and material meaning. Covers FLOW-1/2.

- **AC-1:** When Create succeeds, the task shall display its saved brief and exact
  next occurrence; no execution claim shall precede successful validation.
- **AC-2:** If timing/material is ambiguous or a save conflicts, the surface shall
  preserve the draft and require the missing product choice or conflict resolution.
- **AC-3:** When a conversation creates a task, future runs shall use the captured
  assignment and explicit materials without treating the whole chat as instructions.

**FR-2:** Separate timing from execution under BR-1 through BR-5 and BR-9/13.

- **AC-4:** When three repeating times pass while unavailable, recovery shall
  perform one latest check and expose the earlier skipped range.
- **AC-5:** When a one-off time passes while unavailable, the task shall await
  Run this time or Skip this time; either resolves that exact occurrence. Resume
  after intentional pause shall not backfill that interval.
- **AC-6:** When Run now is selected on a paused or ended plan, one execution
  shall start without changing the plan; duplicate activation shall not overlap it.
- **AC-7:** When a running task is paused or renamed, its captured execution shall
  continue unchanged; Stop run shall remain distinct from Pause schedule.
- **AC-8:** When timezone or date rules cross DST or a missing month day, preview
  and actual occurrence evaluation shall agree on BR-13.

**FR-3:** Present delivery and processes through their canonical facts. Covers
FLOW-3 and BR-6/7.

- **AC-9:** When a run delivers an answer, its detail shall show that answer,
  available output references, and the exact originating run/Turn navigation.
- **AC-10:** If output is clipped, missing, or expired, the surface shall state
  availability without rewriting successful execution into failure or inventing output.
- **AC-11:** When a background server survives result delivery, detail shall show
  both the delivered answer and live process state; log observation shall not be
  labelled a final result or readiness proof.
- **AC-12:** When earlier runs are selected beyond the first page, navigation shall
  open each exact run and restore the task's list/detail context on return.

**FR-4:** Supply actionable attention and explicit handoff. Covers FLOW-4/5.

- **AC-13:** When a run requests input, answering shall reach that live request;
  merely reading it shall not clear attention or permit overlapping foreground work.
- **AC-14:** When a terminal failure is acknowledged, only attention shall change;
  execution outcome, recurrence, and unresolved generic ownership fences shall remain.
- **AC-15:** When Discuss result is used, the new user conversation shall receive
  the selected result reference; its messages shall not silently edit future tasks.
- **AC-16:** When archive is reversed, history shall remain available and timing
  shall remain paused until explicitly resumed.

**FR-5:** Integrate shared configuration, sources, resources, and availability.

- **AC-17:** If Agent or task admission is unavailable, the workspace shall preserve
  task visibility where readable, show the owning issue, and avoid new execution.
- **AC-18:** When service Retry follows an accepted run, reconciliation shall reuse
  its existing execution rather than interpreting Retry as Run again.
- **AC-19:** When source exclusion/removal or recovery invalidates a historical
  result, continuity and handoff shall honor the same source rules as shared records.
- **AC-20:** When configuration/profile files change, the next eligible run shall
  use the configuration owner's accepted selection and provenance exclusions;
  canonically accepted execution shall retain its admitted snapshot and capability
  limits. Unaccepted preparation revalidates before admission.
- **AC-21:** When a task or Project is archived/removed with retained resources,
  cleanup shall use recorded ownership and preserve user-managed source directories.

**NFR-1:** The whole path supports keyboard operation, focus restoration, native
scrolling, light/dark, contrast, reduced motion, and reduced transparency under
the [design system](../spec/design-system.md). UI chrome uses the existing token,
icon, menu, and overlay contracts. No raw protocol IDs or debug state are normal
task labels.

- **AC-22:** When used at narrow pane widths or with keyboard navigation, create,
  attention, run selection, pause, stop, and handoff shall remain reachable without
  clipped controls, hover-only actions, or lost focus on close.

**FR-6:** Provide complete Agent task management through the packaged CLI and
on-demand Skill, with no dedicated scheduling model tool. Covers DEC-6 and
BR-16/17.

- **AC-23:** When an eligible Agent receives a complete scheduling instruction,
  loading the Skill and invoking the packaged CLI through Bash shall create a task
  visible in the same workspace; the model catalog shall contain neither
  `automation_update` nor a replacement scheduling tool.
- **AC-24:** When UI and CLI edit the same revision concurrently, at most one
  mutation shall succeed; the other shall receive a conflict with its intended
  changes intact. Both paths shall apply the same timing and material validation.
- **AC-25:** When a create or run reply is lost and the identical request is
  repeated, the Host shall return the original accepted operation without a second
  task or run, including after restart and after the first run has finished.
- **AC-26:** When a delegated or otherwise disallowed execution invokes the CLI
  directly, Host admission shall reject it before mutation; changing command
  spelling or omitting Skill invocation shall not grant additional authority.
- **AC-27:** When the Host is unavailable or a stop has only been requested,
  CLI output shall report that actual state and shall not claim a saved task,
  completed run, or completed cancellation. CLI exit shall leave accepted work
  owned by the Host.
- **AC-28:** When a CLI run reference points to unavailable history or retained
  background work, Agent inspection shall follow shared source and Tool Task
  ownership without reconstructing a transcript or creating a private process log.

The following cross-flow fixtures close the state boundaries across the six
functional requirements above.

- **AC-29:** When a missed one-off is fulfilled or skipped, its Time passed
  attention shall clear once that decision commits, and no later wake shall admit
  the same occurrence. Failure of the fulfilled run shall create its own issue.
- **AC-30:** When pause/edit races with admission, accepted work shall keep its
  inputs; unaccepted work shall obey the winning task revision. Rename, restart,
  and backward clock movement shall not duplicate an occurrence.
- **AC-31:** When a later run starts or succeeds after an unacknowledged failure,
  that earlier cause shall remain reachable in Needs attention. Answering a live
  question shall continue its existing run rather than create another one.
- **AC-32:** When run state changes while a form is dirty, saving the form shall
  preserve that live state and the edited definition. Local pause shall preserve
  text/focus and advance the base revision without masking an external edit.
- **AC-33:** When a paused one-off has no future time, Resume shall not execute
  it; when an archived task is restored, Run now shall become available while
  automatic timing remains paused. Failed archive shall leave timing unchanged.
- **AC-34:** When a source lacks retained outcome evidence or exact content
  revision, the result shall identify that limitation instead of claiming a
  completed run or a reproducible historical source.
- **AC-35:** When a generated run executes under the profile design, it shall
  preserve Automation exclusions for learned-profile retrieval and learning;
  explicit authored configuration/material shall follow its existing source rules.
- **AC-36:** When a healthy timer wakes slightly late, a one-off shall dispatch
  normally; known unavailability or a forward clock jump spanning its due time
  shall follow BR-3, using the same evaluator in UI, CLI, and the scheduler.
- **AC-37:** When an authorized user conversation inspects/stops a scheduled
  run's process through the CLI, the Host shall prove exact run/Task membership
  and use its canonical owner. An unrelated or substituted Tool Task shall reject;
  ordinary model Tool Task controls shall retain their existing Thread scope.
- **AC-38:** When a previous run's background task completes during a later run,
  its resource update shall remain attached to the original run. Any Agent
  continuation shall wait for shared foreground admission, retain delivery
  provenance, and honor cancellation without starting another scheduled occurrence.
- **AC-39:** When a question reaches its shared Host deadline, the scheduled
  surface shall close that live form, remove only its active-question attention,
  and show the factual no-answer outcome. The same run shall continue and retain
  its foreground slot until its execution owner releases it; Run now shall return
  that existing run, with no extra occurrence or model Turn admitted by timeout.
- **AC-40:** When expiry, interruption, or a delayed reply closes a dirty question,
  the scheduled surface shall use the shared unsent-draft recovery entry. Explicit
  recovery shall preserve the ordinary composer draft; no old-tool submission,
  automatic send, or independent scheduled input store shall be created.
- **AC-41:** When an expired question coexists with unread results, another issue,
  or a newer question, reconciliation shall preserve those independent states.
  Lost notifications/reload shall recover the canonical request outcome without
  inferring acceptance from absence or showing a historical timeout as answerable.

### Recent iteration dependencies and implementation ownership

This is the integration audit, not a claim that every referenced design has
shipped. The live board owns current work status. Recheck the actual PR heads
and file scopes before implementation.

| Mechanism / evidence | Observed position | Consequence for this design |
| --- | --- | --- |
| Context and Projects, #646/#649/#651; [Agent Core](../spec/agent-core.md) | Existing owner boundary | A scheduled assignment saves its own work location and each execution captures its actual address/policy. A conversation default may initialize an explicit choice but is never consulted as mutable run configuration. Scheduling adds no Project model tools. |
| Isolation and workbench simplification, #658/#660; [tool design](../spec/agent-tool-design.md) | Implemented; #660 supersedes private verification/Git machinery from #655/#657 | Use generic Goal/Tool Task, native Git/test commands, Skills, and actual isolation. No new verification receipt ledger, Git publication controller, directory claim, or replacement delegation protocol. |
| Background lifetime and observations, #663; [tool design](../spec/agent-tool-design.md) | Implemented | BR-6/7 consume live observations and terminal receipts separately. Cross-Thread inspection uses validated run/Task ownership; late delivery continuations require shared foreground admission. Result rendering must not terminate surviving background work. |
| Bounded output and source evidence, #661; [resources](../spec/agent-core.md) | Implemented | Display partial/oversized results honestly; use existing complete-output and resource references, not copied previews as evidence. |
| HTTP web search, #662 | Implemented | Research tasks use configured common search tools; scheduling does not require browser state or add a private fetch pipeline. |
| File-first Settings and Skills, #636/#638/#640/#641/#643/#644/#656 | Implemented | Task configuration consumes accepted configuration; global edits remain UI/file/Skill owned. The #666 model-picker fix is also integrated and introduces no new scheduling prerequisite. |
| Outline CLI/Skill, #584/#606; delegation CLI/Skill, #628/#637 | Implemented | DEC-6 follows packaged CLI discovery, literal Bash stdin, bounded receipts, and Host admission. Reuse their transport/admission approach without repurposing document or delegation operations. |
| [Startup fault isolation](../spec/architecture.md#desktop-host-lifecycle), #664 | Implemented | Consume the current scoped readiness, issue actions, admission fencing, and retry ownership, including [Agent startup availability](../spec/agent-thread-rendering.md#startup-availability), when changing Automation lifecycle/Host wiring. |
| [Published conversation records](../spec/agent-core.md#published-conversation-records), #669 | Canonical source/publication owner | Build result process navigation, history access, continuity, and handoff on `ThreadRecordSources` and `ThreadRecordPublisher`. Preserve approved discovery across non-excluded persistent roots, including Automation roots and self; delegated/ephemeral isolation and file capabilities still apply. Do not add another transcript tree or new history model tools. |
| [Memory/profile](memory-agent-profile.md), #665 | Design integrated; runtime absent | Global preferences, identity, style, and learning remain with that owner. Task briefs contain work-specific instructions. Consume accepted configuration without a direct USER.md reader or task-local learned profile. |
| [Targeted conversation recovery](targeted-thread-recovery.md) | Design only | Preserve definition/run fences and shared references. Coordinate final new assignment and run references with its recovery closure; no separate repair action or cleanup interpretation. |
| [Bounded user input](user-input-request-recovery.md) | Design only | Consume its request settlement, 60-second default deadline, session-local answer drafts, and exact active-question attention rules. Whichever consumer lands later verifies AC-39/40/41 against the final shared owner; no parallel timeout or input ledger. |
| [Conversation work folders](conversation-work-folders.md) | Shared Project/location contract | Resolve an explicitly selected Project through its primary-folder owner while retaining the assignment's independent work-location choice. Share packaged CLI admission; changing the originating chat cannot redirect an accepted or future scheduled run. |
| [Background continuation policy](background-task-continuation-policy.md) | Shared Task responsibility contract | Preserve launch/handoff, watch and exact-event disposition through the Task owner. Silent process observations do not acquire the foreground slot; required continuations retain their original run association and shared admission. |
| [Delegation](../spec/agent-delegation.md), #628/#637 | Implemented common mechanisms | Internal/external delegated work remains owned by generic Task/session mechanisms and keeps existing discovery and cancellation boundaries. |

**Implementation suggestions:** Keep the existing scheduling and Agent execution
owners where they satisfy these product rules. Revise the assignment and
delivery projection, independent controls, and workspace navigation together.
The result projection reads canonical facts and persists only user-owned task
configuration, run association, and attention acknowledgement where needed.
It is rebuildable and does not become another authoritative output ledger.

Expected implementation areas are `src/core/agent/automation.ts`,
`src/main/agent/automations/`, `src/renderer/agent/automations/`, sidebar/workspace
navigation, shared exact-run navigation, i18n, and focused Core/renderer/E2E
tests. CLI work also touches the packaged CLI entry/build wiring, a built-in
scheduling Skill, built-in Skill discovery, Bash admission/Host wiring, the model
tool catalog and Automation tool registration/retirement. `package.json`, build
configuration, Host/preload, or shared Agent protocol changes require coordinated
scope. The CLI contract and Skill ship together with the complete feature.
Current intended behavior is folded into `docs/spec/agent-automations.md` and
the affected tool, Skill, workspace, and rendering specs in the implementing PR.
The main agent owns board and changelog changes.

**Collision result:** The document-only scope is this file. The integrated
#664 and #666 changes do not claim it. Product implementation consumes #664's
current Host/lifecycle contracts and overlaps the unified-record/recovery plans
on source and navigation ownership. Land against final startup and unified-record
mechanisms.
CLI admission also shares Host/Bash capability wiring with the delivered
delegation path; perform a fresh file-scope check and coordinate its shared
contract before implementation. No currently open PR claims this plan file.
Cross-Thread run/Task resolution and Tool Task delivery admission require the
same shared-owner coordination; neither exists merely because the CLI can return
an ID. Verify this seam with real delayed completion and cancellation fixtures.
Profile implementation need not serialize this work if only its existing
configuration owner is consumed; changes to admission/learning require a new
collision decision. Whichever recovery feature lands later must cover the final
assignment/run references of the earlier feature. This plan does not reorder the
board or broaden another plan's unratified discovery policy.
The board also selects the input, Task-responsibility and Project-location
integration order. These features remain independently useful; the later
implementation adapts its consumer to the earlier owner's final contract rather
than adding a parallel request, location or delivery authority.

### Verification approach

Walk through one current-state project review, one one-off task missed while
offline, one question awaiting a person, one failed write with unknown effects,
and one delivered result with a live development server. Check that the reader
can identify next timing, actual outcome, relevant materials, and the next action.
Prototype observations validate comprehension, not runtime behavior.

Implementation verification maps AC-1 through AC-41 to meaningful owner and
cross-layer fixtures. Run required typecheck, relevant tests, docs and diff
checks, real Electron light/dark interaction, and interruption/restart fixtures.
Include a packaged CLI/Skill discovery smoke test, command/receipt validation,
UI/CLI conflict, lost-reply/restart idempotency, and direct-invocation admission
checks. Verify removal from the default catalog and active built-in instructions;
archived documentation remains provenance.
Include question expiry while typing, shared draft recovery, late-answer/snapshot
ordering, unrelated attention/unread preservation, and Run now while the resumed
run still owns foreground admission. Coordinate this fixture with the user-input
plan's AC-18; consume its final owner rather than duplicate its state machine.
Use clone-isolated test data; the design work never resets installed data.

## Open questions

**OQ-1:** Ratify the proposed local current-state scope and missed-one-off policy
with real tasks. The recommended behavior is DEC-3 and BR-2/3; interval-complete
or cloud work would require a different delivery commitment and scope.

**OQ-2:** Ratify the stable task/result workspace and one primary work location.
The recommended behavior is DEC-2 and TRD-1; this deliberately removes the need
to choose a Thread destination or configure project fan-out.

Discovery follows the delivered
[published conversation record contract](../spec/agent-core.md#published-conversation-records):
non-excluded persistent roots across Profiles, Automation roots and self, with
delegated/ephemeral isolation and file-capability checks. This design requires
eligible task-owned results and explicit handoff references; it does not broaden
that authority or introduce another record-discovery approval gate.
