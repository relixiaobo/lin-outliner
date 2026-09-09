# Background Task Continuation Policy

## Goal

Let a person start an application or server for their own use without its later
exit creating an unsolicited Agent investigation. Preserve continuation when a
build, test, export, or delegated job still owes the user a result.

**Shape:** ONE complete feature in one PR. Task intent, explicit service handoff,
Host admission, durable event disposition, tool/Skill guidance, presentation, and
recovery tests ship together. This is a proposed implementation contract; current
behavior remains defined by [tool design](../spec/agent-tool-design.md). Work
status and merge ordering belong to [the board](../TASKS.md).

## Non-goals

- A new process manager, terminal, daemon mode, scheduler, or verification ledger.
- Inferring user intent from command names, elapsed time, exit codes, or log text.
- Automatic service replacement, health polling, or repair authority merely
  because a process runs in the background.
- Suppressing successful finite-job results, bypassing process isolation, or
  dropping logs and process ownership to avoid notifications.
- Fixing Outline Runtime startup or asserting that its logs caused the reported
  exit. Reliable question presentation is a separate
  [complete feature](user-input-request-recovery.md).

## Design

### Reader, evidence, and constraints

OBJ-1: A delivered service's exit must create zero additional model calls by
default, while an unhandled finite-job result remains available for continuation.

EVD-1: The reported workflow launched a development application, returned while
building, and later started a new Agent Turn when the user closed the application.
The Agent inferred a startup fault from exit timing and Runtime error logs and
eventually requested another user decision. Neither those logs nor exit code zero
establishes the reason the application closed.

EVD-2: `ToolTaskStore.pendingDelivery` selects all pending terminal background
tasks, including success and cancellation. `ToolTaskService.deliver` calls
`ToolTaskHost.startCompletionTurn`, which `ThreadService` binds to
`TurnLifecycle.tryStartTurnIfIdle`. `deliveryContext` instructs the Agent to
continue authorized work when an event reveals failure. There is no service
handoff or independent continuation obligation in that selection.

CON-1: Keep `ToolTaskService`, its supervisor, Task identity, durable receipts,
artifact settlement, execution context, and isolation as the sole process owners.
Keep the existing delivery batch and Turn admission identity for events that
actually require model execution. No second notification queue or receipt store.

CON-2: Background execution controls waiting behavior only. Task purpose,
process state, remaining Agent responsibility, and user attention are separate.
An idle conversation, final assistant message, or absence of a Goal does not
prove that a pending result has been handled.

The selected brownfield target adds responsibility and event disposition to the
existing owners. A prompt-only change cannot prevent model calls. An exit-zero
filter loses successful jobs, and command-name heuristics fail for wrappers and
custom scripts. The minimum acceptable implementation must cover both service
handoff and finite-result delivery, including interrupted delivery recovery.

### Decisions and business rules

DEC-1: Record the completion agreement at task admission. Its semantic choices
are a finite result, a service to start and hand over, or an explicitly requested
service watch. Ordinary existing finite producers, including delegation, retain
result delivery. Background mode alone never selects handoff or monitoring.

DEC-2: A service launch remains the Agent's responsibility until it verifies the
requested application is usable and explicitly hands it over. Handoff ends that
launch obligation but retains Host ownership, resource accounting, output,
inspection, Stop, and ordinary application-Quit cleanup.

DEC-3: An explicitly requested watch retains a continuation obligation for the
addressed service until its terminal event is handled or that watch is revoked.
It does not introduce periodic health checks. A replacement process, if within
the original authorization, receives a new Task identity; the Host never
restarts a command automatically. New permissions still require their own
authority, and an exit does not expand the user's request.

FR-1: The Agent can declare the agreement at launch and explicitly hand off an
owned service through the Task owner. The development Skill must use this flow.
Do not overload the read-only `task_status` operation with a mutation, or infer
handoff from natural-language output. Unspecified agreements preserve existing
finite-result semantics rather than silently discarding results.

FR-2: Handoff references the exact Task and existing completed readiness-check
Items or observations from the authorized execution lineage. A live process,
build progress, or a frontend listening alone is insufficient application
readiness. Use an appropriate existing endpoint, Runtime, or application check.
The Host validates identity, ownership, reference availability, and current Task
state; it does not certify arbitrary log semantics or create a private verifier.
Missing or failed readiness evidence leaves the launch obligation unresolved.

FR-3: Every settled event updates compact Task facts. Before allocating a model
Turn, the Host determines whether an applicable, unrevoked obligation still
requires that event. The default routing is:

| Agreement and event | Task / UI effect | Agent continuation |
| --- | --- | --- |
| Finite result settles, whether success or failure | Retain factual outcome and outputs | Deliver the unhandled result once |
| Service exits before handoff | Record exit; launch remains unfulfilled | Continue the unfinished launch request once, unless explicitly cancelled |
| Handed-over service exits with code zero | Show exited state and retained details | None |
| Handed-over service exits nonzero, by signal, or with uncertain outcome | Show exit facts or uncertainty in Task details; retain visible issue state where applicable | None by default; no unsolicited diagnostic reply |
| Exact service watch receives a terminal event | Update the watched Task | Continue within the recorded watch agreement |
| Explicit Stop/revocation settles | Show stopping until actually settled, then factual outcome | No revival of the stopped responsibility |

FR-4: Store whether an event was handled without model execution or admitted to
a completion Turn, with its reason and source identity. A silent disposition is
not a fabricated delivered Turn. It must leave the pending queue, participate in
existing retention eligibility, and survive restart. A blocked reconciliation is
not silent success; preserve its issue and ownership until the owner resolves it.

FR-5: Exit evidence records code, signal, timestamps, and the source of an
observed Stop request. Distinguish UI Stop, Agent-requested stop, and Host
shutdown when those actions are known. Closing an external application window
may only yield process-exit facts; its initiator then remains unknown. Shutdown
errors and earlier stderr must not be promoted into a causal diagnosis.

FR-6: Revalidate responsibility at completion-Turn admission, after any wait for
an idle Thread. Stop, handoff, and delivery decisions serialize through the same
Task/Turn owners. A terminal task cannot be handed over as a running service.
Revoking one obligation does not cancel unrelated work or implicitly stop every
background process when its initiating Turn is interrupted.

FR-7: A result already explicitly handled by the active Turn must not produce a
second report. Record handling against the exact terminal event; merely reading
`task_status` is not acknowledgement. Reuse existing batch identity and recovery
for admitted Turns. If admission already committed, cancellation follows that
Turn's owner rather than rewriting history or pretending the call never ran.

### Flows, UI behavior, and recovery

FLOW-1: The user requests a dev application. The Agent launches an owned service,
checks usable startup, commits handoff, and reports availability. The user later
closes it. Task state changes; the conversation gains no new Turn or reply.

FLOW-2: A startup check fails or the process exits before handoff. The original
launch request remains unfinished. The Agent uses verified evidence to continue
within that request, or reports a concrete blocker. No claim of successful
handoff is based on build-progress output.

FLOW-3: A finite background job returns while another Turn is active. Its result
remains pending under the original source identity, is revalidated when admission
becomes available, and is handled once. Switching conversations does not move it
to whichever conversation is currently selected.

FLOW-4: Stop races with task exit, or the Host restarts. Reconcile the exact
process and event disposition before any new work. A service handed over before
restart remains handed over; restart does not restore a cancelled watch or
redispatch an already handled event. Existing uncertainty fences remain active.

Task details distinguish running, stopping, and exited facts from responsibility.
Use concise localized copy for launch verification or an explicit watch where
needed. Avoid showing protocol enums or task IDs as explanation in ordinary chat.
Retain current light/dark and accessibility rules; no new modal or per-task
notification-settings panel is required.

### Implementation scope and dependencies

Implementation suggestions follow the behavioral contract above. Final public
tool names and field spelling are reversible local choices, but the launch and
explicit handoff operations must be usable by the Agent in this same feature.

- `src/main/agent/tasks/toolTaskTypes.ts`, `ToolTaskStore.ts`,
  `ToolTaskService.ts`, and `toolTaskSupervisor.ts`: agreements, responsibility,
  Stop provenance, event disposition, persistence, retention, and race handling.
- `src/main/agent/capabilities/agentLocalTools.ts`, `runtime/ToolRuntime.ts`,
  `src/core/agent/tools.ts`, `protocol.ts`, and `codec.ts`: launch/handoff and
  bounded factual inspection contracts; preserve finite producer defaults.
- `src/main/agent/ThreadService.ts`, `thread/TurnLifecycle.ts`, and
  `context/ProcessObservations.ts`: source-bound admission and context that does
  not resurrect handed-over work. Update the development Skill in
  `src/main/builtInSkills/development/SKILL.md` in the same PR.
- Task strip/details and `src/renderer/agent/store/threadStore.ts`: factual
  state and issue presentation without creating a conversational reply.
- Update current Agent tool, runtime, core, delegation, and rendering specs at
  implementation, wherever their existing all-results-deliver premise changes.

Collision check found no competing claim on this plan file. The implementation
overlaps PR #669's `ThreadService`, runtime/context, record publication, and
related specs; consume its final shared mechanisms or agree an isolated shared
interface first. PR #670's Project/work-directory design must continue using the
same execution addresses; this feature does not add directory ownership.
Refresh open claims before implementation rather than relying on this snapshot.

Coordinate with [scheduled work](scheduled-work-redesign.md): process events keep
their original run relationship; pure observations occupy no foreground slot,
and an actual continuation uses the existing run/Turn admission owner. The
[question recovery plan](user-input-request-recovery.md) is independently
shippable; shared Turn/store edits require selected ordering on the board.

Any persisted format change follows the repository's pre-release fresh-dev-data
policy, with no legacy reader. This plan does not authorize deleting anyone's
current data. Coordinate infrastructure-owned files before editing them.

### Acceptance and verification

| ID | Observable acceptance |
| --- | --- |
| AC-1 | After verified handoff, closing a dev app produces zero new model requests and zero new conversation Turns, with exit facts still inspectable. |
| AC-2 | A handed-over service's nonzero or signal exit retains issue details without automatically diagnosing or restarting it. |
| AC-3 | Build progress alone cannot complete handoff; failure or exit before handoff remains available to the launch continuation. |
| AC-4 | Successful and failed finite jobs, including delegation, are each handled once; success is not filtered by exit code. |
| AC-5 | An explicit watch can continue on its addressed event; Stop/revocation prevents late events from reviving that responsibility. |
| AC-6 | Handoff/Stop versus terminal settlement and busy-Thread admission races retain one consistent disposition and no duplicate report. |
| AC-7 | Host restart and renderer reload preserve silent dispositions, pending results, exact source ownership, and surviving process controls. |
| AC-8 | Unknown exit initiators stay unknown; logs and elapsed time alone cannot establish a crash or authorize repair. |
| AC-9 | Silent settlement remains eligible for normal detail retention/cleanup and does not permanently block archive through a pending-delivery flag. Live processes retain existing archive/delete restrictions. |
| AC-10 | Scheduled-run and delegated results retain their own admission, capability, cancellation, and resource relationships. |

Extend `agentToolTasks.test.ts`, `agentThreadService.test.ts`, kernel/local-tool
tests, codec/projection tests, and renderer Task tests. Assert actual gateway
request counts, event identities, and restart state, not only model wording.
Add a real-Electron startup/handoff/exit check with isolated dev userData, plus
light/dark verification of changed Task presentation. Run typecheck, relevant
Core/renderer/E2E checks, `bun run docs:check`, and `git diff --check`. Fold the
design into specs and archive the plan only after that complete feature ships.

## Open questions

OQ-1: At implementation-plan ratification, confirm the recommended default that
all handed-over service exits, including nonzero/uncertain exits, update Task
attention without waking the Agent. This avoids guessing whether the user closed
the application; the accepted tradeoff is that continued diagnosis requires an
existing watch agreement or a new user request. Do not silently implement a
different rule based on stderr or exit timing.

## Implementation checklist

- [ ] Settle the agreement/handoff contract and shared-owner collision order (FR-1/2/6, OQ-1).
- [ ] Implement launch, evidence-linked handoff, routing, disposition recovery, and all consumers in one PR (FR-1 through FR-7).
- [ ] Verify AC-1 through AC-10, fold specs, and complete the board/archive lifecycle.
