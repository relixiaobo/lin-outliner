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
- **TRD-1:** A task has one primary work location. Several explicit reference
  materials are supported. Separate locations requiring separate executions use
  separate tasks rather than a hidden fan-out multiplier.
- **TRD-2:** Each run receives a task brief and bounded continuity. A permanently
  growing conversation is not the task's memory or configuration authority.
- **EVD-1:** The user requested a clean-slate product and interaction design and
  specifically required consideration of recent related iterations.
- **EVD-2:** The integration baseline was inspected at `origin/main` commit
  `7d89e698`; the dependency audit below distinguishes implementation from plans.
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
| Run | One accepted scheduled or manual invocation with its captured brief and source identities | Scheduling reference plus canonical execution owners |
| Result | Delivered answer, output references, availability, and links to exact process/history | Canonical Turn, Item, and resource owners; rebuildable presentation |
| Attention | A question, failed/interrupted execution, or unresolved outcome requiring action | Reference to its actual cause plus user acknowledgement |
| Background process | Owned work that can remain live after the initiating Turn | Generic Tool Task owner |

The task owns no copied transcript, tool-result ledger, process registry, or
global user profile. A result preview identifies its run and source. An
unavailable source is displayed as unavailable and remains distinct from failure
of the original work. A later task rename does not rewrite an old run's brief.

### Work instructions and execution context

The primary form asks for **Task**, **When**, and **Materials**. A suggested
editable name derives from the task text. Materials support explicit notes,
files, URLs, and one optional saved Project or work folder. The UI distinguishes
reference material from the primary work location.

Linked material is read at execution time; the run records the version actually
read. Required missing material blocks that run with a precise repair route;
it never expands the work location or silently substitutes an unrelated source.
The brief is an instruction scope, not a new filesystem permission boundary.
Normal configured capabilities and actual execution policies remain authoritative.

Each run receives the captured brief, configured instructions/capabilities, the
last relevant result and unresolved issue pointers, and access to eligible older
records when needed. Previous model output stays untrusted historical data.
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
Questions use the existing user-input interaction in place. A delivered result
with a surviving process also displays **Background work: running** with the
shared status/log and Stop process actions. One status never stands for both.

**SCREEN-3: Create/edit sheet.** A compact modal form contains task text,
materials, and a readable time builder; Advanced is collapsed. Once, hourly,
daily, selected weekdays, monthly dates, and yearly dates share one time model.
The form always previews the next concrete local date/time and timezone. Invalid
calendar combinations explain the next valid occurrence. Custom protocol text
is not required. Calendar and time entry reuse native-feeling shared controls.

Create validates before activation. Edit saves one revision; conflict preserves
the draft and offers comparison/reload, not last-writer-wins overwrite. Close
with dirty content offers Keep editing / Discard. Saving changes future
unaccepted work; an accepted run keeps its original brief. The edit sheet includes
a saved-plan Pause schedule action that remains usable independently of the
draft. Pausing retains the draft and updates only the saved timing state.

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

**FLOW-3: Return to results.** Open Scheduled tasks, choose a task, read its latest
delivery, follow an artifact or exact process reference, and optionally discuss
the result. A run with no changes says so only when the execution actually
reported that finding. Empty output is not interpreted as no changes or success.

**FLOW-4: Handle an exception.** Needs attention opens the exact run. Answer a
live question, repair a missing dependency, inspect an uncertain side effect,
run again explicitly, or acknowledge a terminal failure. Acknowledgement changes
attention only. It never retries execution, fabricates success, or clears a
runtime ownership fence. Repair uses the original owner and reports its result.

**FLOW-5: Change or end the arrangement.** Edit affects future accepted runs;
Pause affects future automatic admission; Run now is independent; Stop run
targets current execution. Archive is reversible after active work has settled.
If owned background work remains, resolve or explicitly retain it through its
owner before archive; archived task references still expose retained resources.

### Business rules and failure recovery

| Rule | Observable behavior |
| --- | --- |
| BR-1: Execution promise | Runs require Tenon and required resources to be available. The time builder and unavailable surface state this local execution condition. |
| BR-2: Repeated catch-up | After involuntary unavailability, run current-state work once for the latest missed occurrence. Older missed times form a visible skipped range. |
| BR-3: One-off missed time | If Tenon was unavailable at the one-off time and did not accept that run, show Time passed with Run now / Skip. Never silently perform potentially stale one-off work. |
| BR-4: Intentional pause | Resume schedules future occurrences from resume time. The intentionally paused interval is not backfilled. Run now remains available while paused or ended. |
| BR-5: Concurrent work | One foreground execution per task; live questions and unsettled foreground work occupy it. Further repeated times coalesce. Repeated Run now activation returns the existing active run. |
| BR-6: Background lifecycle | Explicit background processes use generic Task ownership and can outlive result delivery. Their liveness is visible separately. They do not by themselves hold the foreground slot forever or authorize replacing an existing service. |
| BR-7: Delivery truth | Dispatch acceptance, a running log observation, Turn termination, and verified requested outcome are distinct facts. Missing/partial output retains successful canonical operations and shows bounded omission. |
| BR-8: Recovery and retry | Service Retry restores owner readiness and reconciles admitted work. Run again creates a new invocation. Unknown effects or process ownership block unsafe replay; the UI links to recorded effects and the existing recovery owner. |
| BR-9: Timing versus execution | Pause does not cancel accepted work. Manual execution does not advance recurrence or reactivate an ended plan. Stopping is nonterminal until its owning processes/tasks settle or report uncertainty. |
| BR-10: Edits | Captured work does not change under an executing run. Name-only edits do not cancel pending execution. A saved plan change affects unaccepted future timing and displays its concrete next occurrence. |
| BR-11: Attention | Questions, failures, empty expected delivery, and unresolved outcomes remain actionable. Unread results are independent. A later result does not silently dismiss an older unresolved question or uncertainty. |
| BR-12: Notices | Persist results in the task. Use existing native-notification preferences for new questions/failures; deduplicate each attention transition. No per-task notification settings or completion-notification storm. |
| BR-13: Time semantics | A saved IANA timezone anchors local wall time. Travel does not silently move it. Skip nonexistent DST times, run ambiguous times once, and preview the next actual occurrence. Monthly dates absent from a month skip that month. |
| BR-14: Scope and history | Task archive, conversation removal, Project removal, and resource expiry follow their own ownership. Unavailable old records remain labelled; future work depends on current explicit material, not hidden historical aliases. |
| BR-15: Ordinary failure | A known terminal failure raises attention without changing the enabled plan. Future runs follow timing after required admission becomes available. Uncertain side effects retain the stronger generic recovery fence. |

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
  Run now or Skip; resume after intentional pause shall not backfill that interval.
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
  use the configuration owner's accepted selection; a prepared run shall retain its
  admitted snapshot and capability limits.
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

### Recent iteration dependencies and implementation ownership

This is the integration audit, not a claim that every referenced design has
shipped. The live board owns current work status. Recheck the actual PR heads
and file scopes before implementation.

| Mechanism / evidence | Observed position | Consequence for this design |
| --- | --- | --- |
| Context and Projects, #646/#649/#651; [Agent Core](../spec/agent-core.md) | Implemented | One work-location hint resolves through existing Project/context owners. Each real tool execution keeps its own captured address and policy. No sticky Thread cwd or new Project management tools. |
| Isolation and workbench simplification, #658/#660; [tool design](../spec/agent-tool-design.md) | Implemented; #660 supersedes private verification/Git machinery from #655/#657 | Use generic Goal/Tool Task, native Git/test commands, Skills, and actual isolation. No new verification receipt ledger, Git publication controller, directory claim, or replacement delegation protocol. |
| Background lifetime and observations, #663; [tool design](../spec/agent-tool-design.md) | Implemented | BR-6/7 consume live observations and terminal receipts separately. Result rendering must not terminate surviving background work. |
| Bounded output and source evidence, #661; [resources](../spec/agent-core.md) | Implemented | Display partial/oversized results honestly; use existing complete-output and resource references, not copied previews as evidence. |
| HTTP web search, #662 | Implemented | Research tasks use configured common search tools; scheduling does not require browser state or add a private fetch pipeline. |
| File-first Settings and Skills, #636/#638/#640/#641/#643/#644/#656 | Implemented | Task configuration consumes accepted configuration; global edits remain UI/file/Skill owned. The open #666 model-picker fix is a separate renderer lane. |
| [Startup fault isolation](startup-fault-isolation.md), #664 | Implementation claim open | Consume final scoped readiness, issue actions, admission fencing, and retry ownership before changing Automation lifecycle/Host wiring. |
| [Unified session records](unified-session-records.md), #654 | Design integrated; runtime absent | Build result process navigation, history access, continuity, and handoff on its final exact-source/publication contract. Do not add another transcript tree or new history model tools. Its OQ-1 discovery membership still requires its own decision. |
| [Memory/profile](memory-agent-profile.md), #665 | Design integrated; runtime absent | Global preferences, identity, style, and learning remain with that owner. Task briefs contain work-specific instructions. Consume accepted configuration without a direct USER.md reader or task-local learned profile. |
| [Targeted conversation recovery](targeted-thread-recovery.md) | Design only | Preserve definition/run fences and shared references. Coordinate final new assignment and run references with its recovery closure; no separate repair action or cleanup interpretation. |
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
tests. Host/preload or shared Agent protocol changes require coordinated scope.
Current intended behavior is folded into `docs/spec/agent-automations.md` and
the affected workspace/rendering specs in the implementing PR. The main agent
owns board and changelog changes.

**Collision result:** The document-only scope is this file. At the recorded
baseline, open #664 and #666 do not touch it. Product implementation overlaps
#664 on Host/lifecycle and the unified-record/recovery plans on source and
navigation ownership. Land against final startup and unified-record mechanisms.
Profile implementation need not serialize this work if only its existing
configuration owner is consumed; changes to admission/learning require a new
collision decision. Whichever recovery feature lands later must cover the final
assignment/run references of the earlier feature. This plan does not reorder the
board or broaden another plan's unratified discovery policy.

### Verification approach

Walk through one current-state project review, one one-off task missed while
offline, one question awaiting a person, one failed write with unknown effects,
and one delivered result with a live development server. Check that the reader
can identify next timing, actual outcome, relevant materials, and the next action.
Prototype observations validate comprehension, not runtime behavior.

Implementation verification maps AC-1 through AC-22 to meaningful owner and
cross-layer fixtures. Run required typecheck, relevant tests, docs and diff
checks, real Electron light/dark interaction, and interruption/restart fixtures.
Use clone-isolated test data; the design work never resets installed data.

## Open questions

**OQ-1:** Ratify the proposed local current-state scope and missed-one-off policy
with real tasks. The recommended behavior is DEC-3 and BR-2/3; interval-complete
or cloud work would require a different delivery commitment and scope.

**OQ-2:** Ratify the stable task/result workspace and one primary work location.
The recommended behavior is DEC-2 and TRD-1; this deliberately removes the need
to choose a Thread destination or configure project fan-out.

The unified-record plan's discovery OQ-1 remains with that plan. This design
requires eligible task-owned results and explicit handoff references and does
not assume blanket cross-profile or delegated discovery permission.
