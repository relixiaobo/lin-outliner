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

DEC-1: Record the completion agreement at task admission. A finite job owes a
result; a service owes verified launch and handoff. An explicitly requested
service watch is an independent obligation on that exact service, so handoff can
complete the launch without cancelling its watch. Ordinary existing finite
producers, including delegation, retain result delivery. Background mode alone
never selects handoff or monitoring. Do not relabel a finite job as a service to
discard its result.

DEC-2: A service launch remains the Agent's responsibility until it verifies the
requested application is usable and explicitly hands it over. Handoff ends that
launch obligation but retains Host ownership, resource accounting, output,
inspection, Stop, and ordinary application-Quit cleanup.

DEC-3: An explicitly requested watch may be recorded at launch or added to an
owned live service later. It retains a continuation obligation until its terminal
event is handled or that exact watch is revoked. Revocation leaves the process
running and does not reinstate a completed launch obligation. Each new watch has
a distinct identity; an old revocation cannot cancel a later watch. A watch does
not introduce periodic health checks. A replacement process, if within the
original authorization, receives a new Task identity and an explicitly recorded
agreement; the Host never restarts a command or transfers a watch automatically.
New permissions still require their own authority, and an exit does not expand
the user's request.

FR-1: The Agent declares the agreement at launch and uses one structured Task
control operation for handoff, result acknowledgement, and watch changes, as
defined below. The development Skill must teach those actions and their order.
Keep `task_status` read-only and `task_stop` as process control. Neither reading
status nor natural-language output changes responsibility. Unspecified launch
agreements preserve finite-result semantics rather than silently discarding
results.

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
| Handed-over service without an active watch exits with code zero | Show exited state and retained details | None |
| Handed-over service without an active watch exits nonzero, by signal, or with uncertain outcome | Show exit facts or uncertainty in Task details; retain visible issue state where applicable | None by default; no unsolicited diagnostic reply |
| Exact service watch receives a terminal event | Update the watched Task | Continue within the recorded watch agreement |
| Explicit process Stop is accepted | Show stopping until actually settled, then factual outcome | Revoke the addressed Task's pending responsibilities; no revival on late exit |
| Watch revocation is accepted | Clear that watch; preserve process facts and controls | Remove only that watch's pending responsibility; another unfinished obligation can still require delivery |

An exit before handoff can address both launch and watch obligations. It is one
terminal event with one disposition and at most one handling Turn, not two
deliveries. Revoking a watch does not suppress an unresolved launch result.

FR-4: Each terminal event has one durable disposition: pending, silent with its
reason, handled in an existing Turn, or admitted to a completion Turn. The latter
two retain their exact handling Turn/Item or existing delivery-batch identity.
A silent disposition is not a fabricated delivered Turn. Every non-pending
disposition leaves the pending queue, participates in existing retention
eligibility, and survives restart. A blocked reconciliation is not silent success;
preserve its issue and ownership until the owner resolves it.

FR-5: Exit evidence records code, signal, timestamps, and the source of an
observed Stop request. Distinguish UI Stop, Agent-requested stop, and Host
shutdown when those actions are known. Closing an external application window
may only yield process-exit facts; its initiator then remains unknown. Shutdown
errors and earlier stderr must not be promoted into a causal diagnosis.

FR-6: Revalidate responsibility at completion-Turn admission, after any wait for
an idle Thread. Stop, handoff, and delivery decisions serialize through the same
Task/Turn owners. A terminal task cannot be handed over as a running service.
Revoking one obligation does not cancel unrelated work or implicitly stop every
background process when its initiating Turn is interrupted. If an explicit Stop
arrives after exit but before delivery admission, revoke that Task's pending
responsibilities even though no process remains to signal. An already committed
handling Turn remains governed by FR-7/9.

FR-7: An active Turn that inspects and takes responsibility for a terminal result
explicitly acknowledges its exact event through Task control before finishing its
response. Acceptance binds handling to that Turn; it does not certify success or
claim the user has received a report. If that Turn subsequently fails or is
interrupted, ordinary Turn recovery retains the result and handling reference;
the event does not generate another automatic completion Turn. Reuse existing
batch identity and recovery for separately admitted completion Turns. Once that
admission commits, a competing acknowledgement returns its disposition and
handling reference without replacing the owner. Cancellation then follows that
Turn's owner rather than rewriting history or pretending the call never ran.

### Task control contract

FR-8: Expose the following actions through one model-callable Task control
operation in this feature. All actions use the existing Task owner and the
caller's authorized root Thread/active Turn; the Host supplies caller Turn/Item
identity. Knowing a Task ID or reading historical evidence grants no control.
The action names below define semantics; final tool/field spelling is local.

| Action | Exact target and precondition | Accepted effect |
| --- | --- | --- |
| Hand off | Owned live service, expected responsibility revision, readiness references required by FR-2 | Complete its launch obligation; retain any active watch and process ownership |
| Acknowledge result | Owned terminal Task and its immutable terminal-event identity, as returned by factual inspection; pending disposition | Bind handling of that event and its applicable obligations to the calling Turn/Item under FR-7; retain outcome, artifacts, and uncertainty fences |
| Start watch | Owned live service with no active watch, expected responsibility revision, and the explicit user request's source reference | Record one active watch and return its identity; preserve launch/handoff state; reject adding a watch to an already terminal Task or replacing an active watch |
| Revoke watch | Exact watch identity and expected responsibility revision | Revoke only that watch, even if exit is already pending; leave the process, launch state, and other responsibilities intact |

Every mutation carries an operation identity. After caller authorization, replay
of the same operation and input returns its recorded receipt before evaluating
fresh-write preconditions; reuse with different input rejects. Thus a handoff
whose reply was lost remains a handoff after the service exits. A new operation
against a stale revision or event returns conflict and bounded current facts.
Receipts identify the operation, exact Task/event/watch, committed revision,
disposition, and handling reference where applicable. `task_status` exposes those
bounded facts and can reconcile an exact operation identity without mutating it.
Duplicate acknowledgement of an already owned event returns the existing handling
reference and never starts or transfers work. A new watch after revocation needs
a new explicit request and identity; retrying the old start cannot restore it.

FR-9: Responsibility mutation, its receipt, and event disposition commit through
the Task owner before a successful tool result is published. Serialize them with
terminal settlement and final Turn admission at the existing owner boundary.
Acknowledgement versus delivery has one winner. Revocation removes its obligation
from an unadmitted event; if no applicable obligation remains, commit a silent
disposition. If admission already committed, return that handling reference and
leave any interruption to the Turn owner; never interrupt unrelated work in its
batch. Failed or uncertain writes cannot return success or drop pending work.
Reconcile an operation identity before retrying. Retain these associations with
compact Task facts under existing lifecycle rules; no second receipt database,
notification queue, or model-output parser is introduced.

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
to whichever conversation is currently selected. If that active Turn inspects and
handles the result, it acknowledges the exact event and reports it; otherwise
the pending result retains its ordinary completion path.

FLOW-4: Stop races with task exit, or the Host restarts. Reconcile the exact
process and event disposition before any new work. A service handed over before
restart remains handed over; restart does not restore a cancelled watch or
redispatch an already handled event. Existing uncertainty fences remain active.

FLOW-5: The user asks to watch an already handed-over service, then later asks to
stop watching while keeping it running. The Agent starts and revokes the exact
watch through Task control. Its eventual exit is silent unless another obligation
still applies. `task_stop` is not used to implement either request.

Task details distinguish running, stopping, and exited facts from responsibility.
Use concise localized copy for launch verification or an explicit watch where
needed. Avoid showing protocol enums or task IDs as explanation in ordinary chat.
Retain current light/dark and accessibility rules; no new modal or per-task
notification-settings panel is required.

### Implementation scope and dependencies

Implementation suggestions follow the behavioral contract above. Launch and all
four Task control actions must be usable by the Agent in this same feature.
Settle their shared-interface shape before building consumers; local spelling
choices must preserve the target, authority, receipt, and race contracts above.

- `src/main/agent/tasks/toolTaskTypes.ts`, `ToolTaskStore.ts`,
  `ToolTaskService.ts`, and `toolTaskSupervisor.ts`: agreements, responsibility,
  Stop provenance, operation receipts, event disposition, persistence, retention,
  and race handling.
- `src/main/agent/capabilities/agentLocalTools.ts`, `runtime/ToolRuntime.ts`,
  `src/core/agent/tools.ts`, `protocol.ts`, and `codec.ts`: launch, the four Task
  control actions, and bounded factual/operation inspection; preserve finite
  producer defaults and update model guidance/catalog coverage in the same PR.
- `src/main/agent/ThreadService.ts`, `thread/TurnLifecycle.ts`, and
  `context/ProcessObservations.ts`: source-bound admission and context that does
  not resurrect handed-over work. Update the development Skill in
  `src/main/builtInSkills/development/SKILL.md` in the same PR.
- Task strip/details and `src/renderer/agent/store/threadStore.ts`: factual
  state and issue presentation without creating a conversational reply.
- Update current Agent tool, runtime, core, delegation, and rendering specs at
  implementation, wherever their existing all-results-deliver premise changes.

Implementation uses the current `ThreadService`, runtime/context and
[published record owners](../spec/agent-core.md#published-conversation-records).
Preserve their source and lifecycle contracts when adding Task responsibility;
coordinate any new shared interface separately. PR #670's Project/work-directory design must continue using the
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
| AC-11 | An active Turn acknowledges an inspected finite result and reports it; returning to idle and restarting the Host produce no duplicate completion Turn. Failure after acknowledgement retains the original handling reference for ordinary Turn recovery. |
| AC-12 | Starting a watch after handoff and revoking it keep the service running. Handoff preserves an active watch, and revoking one before handoff preserves the unfinished launch obligation. A stale revocation cannot affect a newer watch. |
| AC-13 | Lost replies, identical retries, conflicting operation reuse, stale revisions/events, and acknowledgement versus delivery yield one durable effect and a truthful receipt. A committed handoff remains replayable after terminal settlement. |
| AC-14 | Wrong-Thread or hidden delegated callers cannot mutate responsibility; unavailable mutation storage returns no success and loses no pending event. A shared launch/watch exit is handled by one Turn, and revocation after admission does not rewrite or interrupt that Turn. |

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

- [ ] Settle the agreement, Task control, and shared-owner collision order (FR-1/2/6/8/9, OQ-1).
- [ ] Implement launch, all Task control actions, routing, disposition recovery, and all consumers in one PR (FR-1 through FR-9).
- [ ] Verify AC-1 through AC-14, fold specs, and complete the board/archive lifecycle.
