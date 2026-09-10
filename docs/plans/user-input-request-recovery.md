# Reliable and Bounded User Input Requests

## Goal

Ensure that whenever an Agent is waiting for a person's structured answer, that
person can reach the corresponding question in the conversation composer.
The person can answer, leave a question unanswered while browsing, submit partial
answers, or skip the whole request without providing answers. These actions
have explicit sending boundaries and never silently discard earlier answers.
Reload, subscription loss, cancellation, and late replies must not leave an
invisible question or a stale form that the Host can no longer accept. An
unanswered question releases the Agent after a bounded wait instead of suspending
the execution indefinitely.

**Shape:** ONE complete feature in one PR. Authoritative pending state,
snapshot/event synchronization, answer/discussion/cancellation/timeout settlement,
composer interaction, draft recovery, and end-to-end validation ship together.
This plan is the consolidated proposed design; earlier interaction sketches are
not independent authorities. It does not assert that the proposal is implemented;
current behavior is owned by [Agent Core](../spec/agent-core.md) and
[Thread rendering](../spec/agent-thread-rendering.md). Status and selected order
live on [the board](../TASKS.md).

## Non-goals

- Adding a modal, an interview workspace, new question types, or a Settings panel.
  Keep one to three questions and the existing option-or-free-text capability.
- Using questions, silence, skips, or discussion as permission to perform work.
- Durable or cross-device storage of unsent answer drafts. Retention is explicitly
  limited to the current renderer session.
- Automatically choosing an answer because the UI failed to show the form.
- Replaying a tool call or model Turn to reconstruct a question, or reviving a
  historical request after its owning execution has ended.
- Claiming that reload caused the reported incident without evidence, or that
  repairing question presentation fixes unnecessary background continuations.
  That policy has its own [plan](background-task-continuation-policy.md).
- A general workflow engine, new history source, or independent request database.

## Design

### Reader, evidence, and constraints

OBJ-1: An active pending question survives renderer reconstruction under the same
Host, remains answerable exactly once, and disappears after cancellation or
settlement. A missing snapshot produces a reachable recovery state, not ordinary
editable input while the Agent silently waits. A finite Host-owned deadline
releases unanswered requests with an explicit timeout result.

OBJ-2: A person who does not know an answer or does not want to answer can make
progress without inventing an answer, abandoning earlier answers, or stopping the
whole task. The question and useful choices dominate the visual hierarchy.

OBJ-3: Incoming questions, expiry, and delivery failures preserve active typing,
IME composition, selection, existing message content, and attachments. Only an
explicit sending action transfers local content to the Agent.

EVD-1: Inspection of the reported conversation's retained events found an
in-progress `request_user_input` Item, `waitingOnUserInput`, and a valid
`userInput/requested` event. No answer-resolution event followed. Approximately
314 seconds later the request failed with an aborted result and the Turn became
interrupted. This proves Host admission and waiting, not successful UI delivery.

EVD-2: Replaying that request through the renderer codec and `ThreadStore` while
subscribed populated `userInputByThread`. Initializing a fresh store from a Thread
already marked as waiting and its in-progress tool Item did not populate it.
At the incident baseline, `ThreadStore.loadTurns` read history, Goal, and
configuration but no pending request snapshot. Live notification was the only
form-population path.

EVD-3: Replaying the real interruption events after the request left the Thread
idle with the old request still in `userInputByThread`. At that baseline,
`rejectUserInput` removed Host pending state without publishing a cancellation
event; renderer Turn completion did not remove the request. These were two defects,
independent of the unresolved location of the original notification loss.

EVD-4: The user additionally requested that unanswered questions allow the Agent
to continue after a limited wait. At the incident baseline, `autoResolutionMs`
was optional, bounded from 60 to 240 seconds, and omitted in the reported request.
Its timeout handler synthesized an Other answer for every question. The proposed
contract replaces optional unbounded waiting and synthetic answers with a default
deadline and a distinct no-answer outcome.

EVD-5: Source inspection of the local cc-2.1 reference found partial-answer
submission, Chat about this, and a plan-only Skip interview and plan immediately
action. Both conversational exits retain already answered context; plain Cancel
aborts the main execution. Its delayed notification is a reminder, not the bounded
deadline in this plan. These are reference behaviors, not usability-test results.

CON-1: `TurnLifecycle` remains the pending-request and response owner. The current
root-only, one-pending-question-call-per-Thread contract and exact Thread/Turn/Item
answer validation remain. Read access uses existing renderer Thread visibility;
it does not expose hidden delegated contexts or grant execution authority.

CON-2: The renderer is a projection. Host pending state and canonical lifecycle
events govern answerability; rendered tool arguments, cached history, screenshots,
and a waiting flag alone cannot authorize a response. The clean-slate invariant
and selected brownfield target are the same: snapshots recover state and events
keep it current. Reuse the existing owners instead of introducing another ledger.

CON-3: Hard constraints are process isolation, exact-once settlement, finite
Host-owned deadlines, explicit sending, session-local unsent drafts, and the
existing neutral design tokens and accessibility preferences. The selected
interaction directly replaces the composer while a question is pending, with
independent message drafts and automatic restoration after settlement.

### Decisions and requirements

DEC-1: Make current input state a bounded Host-readable snapshot, with no pending
request as an explicit value. Include the pending question's exact identity and
an ordering token sufficient to reject stale reads/events. Cleared state carries
the exact request identity and its answered, discussed, timed-out, cancelled, or failed
outcome; absence alone does not prove which outcome occurred. Reconciliation can
resolve the exact previously observed request through the same owner when newer
requests have superseded it, without returning an unbounded settlement history.
Supply state on initial conversation load and reattachment, not only when the
tool first asks.

DEC-2: The question form replaces the ordinary composer in the same dock area.
Always show the first question directly, regardless of whether the ordinary
composer is empty, contains text, or has focus. Keep the ordinary editor mounted
but hidden: its text, attachments, and selection are independent of answer drafts.
Question arrival never reads those contents into an answer. Submission, Skip all,
and settlement automatically restore the original message draft unchanged, except
while preserving active answer editing at expiry. There is no close/reopen editor
switch or preliminary choice. Arrival may move focus from the hidden composer
into the visible question, but never steals unrelated document focus.

DEC-3: Every question request has a finite deadline. Use 60 seconds for the whole
one-to-three-question request by default; an explicit duration may use the
existing 60-to-240-second bounds for questions needing more time. Omission means
the default, never infinity. Start the deadline at Host acceptance, not UI
visibility, so a lost notification cannot produce an unlimited wait. The default
is a concrete implementation choice for the user's bounded-wait requirement;
there is no new Settings panel.

DEC-4: Separate navigation, answer content, and submission into three stable
regions. The header groups previous/next icon buttons around a compact current /
total indicator. Both navigation buttons stay
visible, with the unavailable direction disabled at each end. Accessible names
and native tooltips identify the icons. Navigation never submits an answer.
The body gives the question stronger type than option labels and descriptions.
Other is an explicit peer radio option; selecting it reveals and focuses its
text editor. Inactive text remains mounted but hidden and never submits with a
preset option. The body alone scrolls inside a bounded, stable-height form, so
navigation and footer actions do not move when Other opens or a question wraps.
The footer places the quiet deadline apart from Skip all and Submit answers. Submit
is available on every step once there is an active answer; it includes the
request's active answers and typed skips for the rest. There is no footer Next,
review page, tab bar, More menu, or execution terminology in the form. Choosing a
recommended option is always an explicit local choice.

DEC-5: Skip all is available on every question and ends the whole request with
only typed skips and continue intent. It never submits existing answers or
mutates their local drafts, including on failure. Submit answers uses answer
intent, sending all active answers with typed skips for unanswered questions.
Navigation is local and never changes the active answer. Escape during a live
question neither dismisses, submits, skips, nor stops work. Neither skipping nor
silence grants authorization.

DEC-6: Draft state and submission are independent even though the two editors
occupy the same area. Ordinary Send/Steer keeps its existing message admission
route when the composer returns; it never reads answers or settles a request.
Answer, Skip all, failure, and timeout never read or clear the ordinary draft.
Message submission likewise leaves retained question drafts intact. There is no
cross-draft transfer control. The Host's atomic discussion contract remains an
explicit API operation, not an interpretation of an ordinary message. No Thread
lock is held while a user types.

DEC-7: Expiry removes answerability, not an active editing gesture. Keep a focused
non-empty answer editor and its selection mounted as an unsent draft. Once focus
leaves that editor, or the person presses Escape after expiry, automatically show
the next pending question or restore the ordinary composer. A newer question does
not interrupt this local editing. Retained content appears as a passive collapsed
note at the original question in the transcript. Native selection/copy remains
available; there is no draft shelf, transfer, copy, delete, or status-check button.
Empty outcomes create no note. Use subdued remaining time and one factual expiry
announcement, without flashing, warning colors, or per-second screen-reader
announcements. Only an authoritative timeout permits a no-answer timeout claim.

FR-1: Expose the authoritative snapshot through the existing Agent Core control
plane. Read request state and execution validity at one owner boundary. Waiting
status and question publication derive from the same accepted request; failed
publication must settle/fail the tool rather than leave an unobservable Promise.
History remains evidence, not a substitute source of live pending requests.

FR-2: Subscribe before reading the snapshot, and merge both with explicit
ordering. A delayed empty snapshot cannot erase a newer request; a delayed
pending snapshot cannot restore an answered/cancelled one. Use a Host-generation
identity with a monotonic per-Thread revision or equivalent existing canonical
ordering. A new Host generation requires resynchronization, not numeric comparison
of unrelated epochs. Expose only bounded pending state, not the entire Rollout.

FR-3: Reconcile on initialization, subscription reattachment, opening a Thread,
and a waiting-state notification without matching request content. A visible
window returning to focus may trigger one coalesced reconciliation of its active
conversation to heal missed IPC. Do not poll the whole catalog. Concurrent reads
use generations/revisions; switching Threads never paints another Thread's form.

FR-4: Settle an answer, a submitted discussion message, timeout, explicit cancellation, tool abort, Turn
interruption, Turn termination, or owner shutdown through one request lifecycle. Each accepted
transition invalidates the exact request and emits authoritative state change.
Do not fabricate an answer to represent cancellation. Preserve existing recorded
answer events and add a cancellation/cleared representation where needed.

FR-5: The renderer clears only the matching request on settlement and treats
matching Turn termination as an immediate stale-form fence. A late settlement
for an older Item cannot erase a new question. A reply validates exact identity
and the still-pending state at acceptance; wrong-Thread, stale, and cancelled
replies are rejected without modifying a newer request or launching another Turn.

FR-6: Response acceptance, request removal, event recording, and Promise
resolution must have a defined commit boundary. If acceptance committed but its
reply was lost, reconciliation must show the answered state and must not resume
the model twice. The same rule applies to discussion and continue submissions.
Duplicate same-response submissions settle consistently; a
conflicting answer after acceptance is rejected. On write failure retain an
answerable request or terminate it with a visible recoverable error, never a
removed request with an unresolved execution Promise.

FR-7: Renderer reload restores a live request from the same Host. A Host restart
follows existing interrupted-Turn recovery: clear/fence the old request and do
not reconstruct its waiting Promise from history. Continuing the conversation
uses the existing recovery action; it does not replay the original tool silently.
Store/return the original finite deadline; UI reload, focus, typing, and question
step navigation cannot restart or extend it. Reconcile an elapsed deadline on
system resume before accepting another response.

FR-8: When a known waiting state lacks request content, show a localized restoring
state in the question area. Reconciliation is automatic. If the read fails or the
Host reports inconsistent state, show an inline error with Try again. Retain the
ordinary editor and its existing execution controls; do not duplicate Stop in the
recovery state. Disable question submission while validity is unknown. The Host
deadline continues during recovery; failure to render cannot extend it. No failure
path invents an answer.

FR-9: Record bounded diagnostics for request publication, snapshot reconciliation,
stale-update rejection, and transport/consumer errors, using Thread/Turn/Item,
revision, and Host generation. Do not log question text or answers by default.
Contain a subscriber failure so unrelated observers remain reachable. Instrument
the actual notification path to determine the original loss site if reproducible;
do not present the known recovery defect as proof of that particular cause.

FR-10: At the deadline, settle the tool with a typed timeout/no-answer result,
clear pending state, remove the waiting flag, and let the same active Turn
continue. Do not select the recommended option or manufacture per-question Other
text. Answered results retain the complete validated answer-or-skip set; timed-out
results carry the request identity and deadline with no fabricated answers.
Draft selections and partial free text are not submitted on timeout, even when
the user answered earlier steps locally.
Distinguish this outcome from user cancellation, tool failure, and authorization.
The model-tool output contract, decoder, context projection, and guidance must
all preserve that distinction.

FR-11: After timeout, the Agent continues independent work and may state a
reversible assumption where existing authorization permits it. Directional,
irreversible, or permission-dependent work still awaits a real user decision.
If nothing useful can proceed, return a concise account of the unresolved input
rather than keep the execution Promise pending. Timeout means no submitted
answer, not user approval or evidence that the user saw the question. Neither the
Host nor the runtime automatically re-asks the expired question; guidance must
prevent a repeated-question loop from replacing the original infinite wait.

FR-12: Serialize answer, timeout, and cancellation against the same request.
Answer acceptance checks the Host clock and pending state; a delayed timer does
not make a reply after the deadline valid. An answer accepted before expiry wins;
otherwise timeout wins, and an interrupt cannot be undone by a late timer. A
response received after expiry shows that the question expired and uses the same
draft-recovery path as timer-driven expiry. It does not resubmit into the old tool
or start another Turn on its own.

### Answer drafts and settlement presentation

FR-13: Keep answer drafts in the renderer's Thread state owner, keyed by exact
Host generation, Thread, Turn, and request Item identity, outside the form
component's lifetime. Update active choice, inactive free text, skips, and step position as the
user edits them; do not wait for Submit or an unmount callback to capture them.
Only the Host snapshot/lifecycle determines whether that request is answerable.
The ordinary composer draft, attachments, and a newer question's answers remain
separate and are never replaced by settlement of an older request.

| Observed request state | Live form | Local answer draft |
| --- | --- | --- |
| Pending | Display or restore the exact request | Preserve edits across step navigation, reconciliation, Thread switches, and dock/form remounts within the same renderer session |
| Answer, continue, or discussion accepted, including a lost reply reconciled later | Close the matching form | Release only the content actually included in that accepted submission; retain withheld free text, skipped drafts, and any newer local edits |
| Timed out, by timer, resume, snapshot reconciliation, or rejected late submission | Fence submission; keep a focused non-empty editor mounted as a local draft, otherwise fold the form | Retain every unsubmitted selection and free-text value, including earlier question steps; never claim they were sent |
| Cancelled, interrupted, failed, or invalidated by Host restart | Fence submission and show the known reason; preserve an active local editor | Retain unsent content for manual recovery; it grants no authority to revive the tool |
| Settlement cannot be determined | Disable submission and reconcile through the existing recovery state | Preserve the draft without claiming acceptance or automatically retrying submission |

Place non-empty retained content beside its original question Item in the
transcript, outside the collapsed process details. A single collapsed summary
shows the question and Not submitted for known withheld content; unknown or
invalidated outcomes use Answer draft instead. Expansion shows the known outcome and all
retained question/answer content. No separate draft-management region or action
buttons appear. The content supports native text selection and copying. If an
inspection-only Item is unavailable, keep the note within its owning Turn.
A newer question, delayed old event, or ordinary message send cannot clear another
entry. Accepted receipts release only the exact submitted content; they never
assume every local field of an answered question was sent.

Draft retention is session-local: full renderer reload or application exit may
discard unsent content, as in the existing draft contract. Neither is required
for automatic expiry, Thread switching, or form remounting, which must preserve
it. Thread deletion removes only that Thread's drafts. Unsubmitted drafts remain
renderer-local: do not persist them in Rollout, transmit them to the Host/model
before explicit submission, or add an independent request database.
Retained content from an old Host generation remains unsent text, never a live
request; ordinary current Thread visibility still governs its recovery surface.

FR-14: Conversation and scheduled-run surfaces consume the same ordered request
settlement. Timeout closes the live question and clears its waiting/active-question
attention cause while retaining the factual no-answer outcome. It does not mark
the run completed, release an executing run's foreground slot, acknowledge other
issues, or mark results read. Independently established unresolved-input, failure,
or uncertainty causes remain actionable under their existing owners. There is no
scheduled-request timer or separate answer ledger; the scheduled-work plan owns
only run presentation and admission around this shared lifecycle.

FR-15: Previous and Next browse locally without answering, skipping, or submitting.
An unanswered question becomes a typed skip only in an explicit submission.
Submit answers is available from any step with an active answer and sends all
active selections or non-empty free text, with typed skips for the rest. Skip all
is a separate action on every step: send only typed skips with continue intent
and retain every existing answer draft. Both routes settle once at the existing
identity/deadline boundary. Failure preserves all local answers for retry. Empty
skips create no recovery item; retained content stays available as an answer draft.
Neither route reads or clears the ordinary message draft or grants authorization.

FR-16: The control plane supports an explicit composite discussion response,
distinct from answered, timed-out, and cancelled outcomes. The caller supplies
the exact request identity, active answers/skips, and message content in one
bounded envelope. This contract is not the ordinary composer's sending route;
ordinary messages carry no implicit question response. Hidden inactive and
skipped draft text must never enter a composite submission.

Acceptance settles the request, records the user's message exactly once through
the existing conversation record owner, and supplies both the message and answer
context to the same Turn before it resumes. It must not be implemented as an
unrelated Skip call followed by an ordinary Send that can fail halfway or open a
second Turn. Existing attachment validation and user visibility still apply.
The Agent responds to the actual message and may reformulate only where that
discussion changes the need; it does not send an empty clarification invitation
or repeat the same questionnaire automatically. Discussion is not authorization.

Lost acknowledgement reconciles the exact receipt before any retry. Known
pre-acceptance failure retains both drafts and permits retry while still pending;
unknown acceptance disables resubmission until reconciled. If timeout wins the
race, no discussion message or local answer is transmitted. Keep the ordinary
draft and explain that it was not sent; after reconciliation, an explicit normal
Send may continue the conversation. There is no automatic conversion of a failed
question response into a new Turn. Stop fences this route under FR-12 as well.

### Flows, UI behavior, and recovery

FLOW-1: The Agent asks a valid question. The Host accepts it, publishes pending
state, and awaits its result. The form directly replaces the composer and displays
the question, options including Other for free text, quiet remaining time, and
local step controls. Selecting an option or typing does not submit. Previous/Next
navigate locally, and the separate Submit answers action submits the active
answers from any question. Skip all ends the request without any answer content.
Explicit submission resolves once and restores the ordinary draft while the same
Turn continues. Leaving a question blank skips it only when answers are submitted;
Skip all restores the message draft without sending any answer content.

FLOW-2: The notification occurs before a new renderer subscribes, or while its
subscription is absent. Initialization/reattachment reads the live snapshot and
renders the same request. Closing/reopening the dock and switching Threads retain
unsent answers through the renderer state owner even if the form remounts. A full
reload may reset unsent drafts; it must restore the question and answerability.

FLOW-3: Stop or Turn termination races with submission or a delayed snapshot.
The Host's accepted ordering decides whether an answer committed. Both sides
clear the old form, and the model resumes at most once. A newer question is not
removed by an old response. No polling, repeated model call, or auto-answer is
used to unblock the control plane.

FLOW-4: Snapshot recovery fails. The composer shows the recovery error and Try again.
The ordinary composer retains its existing task controls. A successful retry restores the live question or normal
editor according to the new snapshot. A stopped or restarted Host produces the
existing execution recovery state, not a restored historical question.

FLOW-5: The user gives no answer. The form shows its remaining wait time and
explains that the Agent will continue without an answer. At the original deadline
the Host returns the no-answer outcome once. With no unsent content, the ordinary
composer returns and no recovery item is created. With non-empty drafts and no
active editor, the form returns to the composer and retained content appears at
the original question in the transcript. The Agent continues
within the boundaries above. A hidden or failed form follows the same deadline;
no UI acknowledgement is needed to release the wait. Unsubmitted selections or
partial free text are not answers.

FLOW-6: The deadline expires while the person types on a later question step.
The old tool becomes unanswerable, but the same editor, caret, selection, IME,
and scroll remain. Further typing stays local. On blur or Escape after expiry,
the ordinary composer returns unchanged, or the next pending question appears.
All unsent content remains under the original question as a collapsed transcript
note. Ordinary message sends, including failed sends, never consume these notes.

FLOW-7: A question arrives while the ordinary composer contains text or IME.
It directly replaces the composer in the dock. The original rich editor remains
mounted but hidden, preserving its text and attachments; that content is never
used as an answer. Submission, Skip all, or settlement restores it unchanged.

FLOW-8: The person does not want to answer. They can leave a question unanswered
and move on with the next icon, or choose Skip all to end the whole request without
answers. The ordinary draft returns automatically. Answer content withheld by
Skip all stays at the original question, with no extra recovery actions.

The action hierarchy is one primary Submit answers action and one secondary
Skip all action. Previous and Next are paired header icons around the position
indicator. The quiet deadline is footer metadata. Keep controls reachable at
narrow widths without horizontal scrolling. Use neutral tokenized states and
ordinary user-facing language. Timeout creates no synthetic user message.

Respect focus within a displayed question. Arrival can focus the replacement form
if the hidden composer held focus; it never overrides another document editing
target. Background updates must not repeatedly reset selection or steal focus.
Selection keys choose locally; Enter/Space activate a focused control, never
submit merely because an option became selected. Escape during a live question
does nothing; after settlement it can end retained local editing. The ordinary
editor keeps its established newline/send shortcuts and task controls when it
returns. Error and loading copy describe the user's state, not protocol revisions
or internal request IDs. Countdown ticks are not live announcements; expiry
explains that no answer was submitted without claiming a choice on the user's
behalf.

### UI copy contract

Use sentence case and the same meanings in English and Simplified Chinese.
Question text and options come from the Agent; interface labels come from the
typed message catalog. Do not explain implementation terms in the form.

| Surface | English copy | Meaning |
| --- | --- | --- |
| Waiting status | Waiting for your answers | Waiting for question answers, not a generic input task |
| Activity row | Questions for you / Questions asked | Do not count tool calls as individual questions or claim answers were submitted |
| Navigation | Previous question / Next question | Icon labels and tooltips; local browsing only |
| Free text | Other; Write your answer… | Explicit free-text option and its editor |
| Secondary action | Skip all | End the request without any answers; retain filled drafts |
| Primary action | Submit answers | Submit active answers and skip unanswered entries |
| In flight | Skipping… / Submitting… | Describe the requested operation while controls are disabled |
| Countdown | Continues in Ns | State what happens when the wait ends; never submit drafts automatically |
| Loading / failure | Loading questions… / Could not load the questions. Try again. | Reconcile automatically; show Try again only on failure |
| Timeout | Time is up. No answers were submitted. | State the known result without blaming the person |
| Retained content | Original question + Not submitted | Passive collapsed content at the original question, not a separate draft shelf |
| Withheld content | This draft was not submitted. | Do not label the whole request skipped after partial submission |
| Unconfirmed receipt | Could not confirm whether your answers were submitted. Your draft is still here. | Keep uncertainty explicit while automatic reconciliation determines the outcome |

Submission and skip failures use separate messages, explain draft retention,
and invite retry; they do not expose raw transport errors. Cancellation, failure,
and unavailable questions use distinct outcome text without promising that the
Agent continued. No unused Skip, Skip and finish, or review labels remain.

### Implementation scope and dependencies

Implementation suggestions use the existing ownership boundary; dev may choose
snapshot method and token names within this contract, with the shared-interface
coordination required by the repository.

- `src/main/agent/thread/TurnLifecycle.ts` and `src/main/agent/ThreadService.ts`:
  authoritative snapshot, request settlement, cancellation, recovery, and exact
  acceptance ordering. Inspect `requestUserInput`, `resolveUserInput`, and
  `rejectUserInput`; do not only patch `UserInputRequest` presentation.
- `src/core/agent/protocol.ts`, `codec.ts`, and `rendererProjection.ts`: bounded
  snapshot, deadline, ordered pending/cleared contracts, response intent, and the
  distinct discussion outcome; validate all response modes at the write boundary.
- `src/core/agent/tools.ts`, `src/main/agent/runtime/ToolRuntime.ts`, and
  `src/main/agent/thread/TurnLifecycle.ts`: default bounded wait, explicit
  no-answer tool outcome, atomic discussion/message acceptance, provider-visible
  continuation guidance, and deadline races without a fabricated answer or new
  model Turn. Use the existing conversation record owner for the user message.
- Existing preload/desktop notification forwarding, if needed for snapshot
  wiring, observation diagnostics, or subscriber-error containment. Keep process
  isolation and renderer visibility boundaries intact.
- `src/renderer/agent/store/threadStore.ts`, `components/ThreadDock.tsx`,
  `ThreadView.tsx`, and `UserInputRequest.tsx`: recovery, merge ordering, exact
  clear semantics, session-owned per-request answer drafts, direct text input,
  direct question steps, an independent ordinary message draft, passive transcript notes,
  draft/focus preservation, and localized settlement/error states. Include the
  existing `UserInputRecovery.tsx` and `store/userInputState.ts` owners. Make the
  form a consumer of draft state rather than its lifetime owner.
- Current core, model-runtime, tool-design, and Thread-rendering specifications:
  fold the final request lifecycle and snapshot behavior in the same feature PR.

Implementation uses the current Thread lifecycle and
[published record owners](../spec/agent-core.md#published-conversation-records).
Preserve their final contracts while coordinating request protocol/codec and
renderer-store changes. The future work-folder implementation also uses Thread
and composer owners. The collision self-check found only this feature's #672
claim open, with no other open-PR overlap. Discussion broadens its original
response contract and must be included in the claim and shared-interface check
before implementation; it is not merely a renderer-only change. No dependency,
build, core document-command, main-owned board, or changelog edits are required.

This feature and [background continuation](background-task-continuation-policy.md)
can each ship alone. Select an integration order for their shared
`ThreadService`, `TurnLifecycle`, protocol, and renderer-store edits; reliable
questions do not depend on adopting new background agreements. The
[scheduled-work plan](scheduled-work-redesign.md) consumes FR-14's answered, discussed,
timed-out, cancelled, and failed settlements, distinct from unread results and
run termination. It preserves its own run admission and introduces no second
scheduled input owner. Whichever implementation lands later adapts the final
shared lifecycle and verifies the scheduled consumer; this plan does not depend
on the future scheduling UI to ship the conversation feature.

### Acceptance and verification

| ID | Observable acceptance |
| --- | --- |
| AC-1 | A real runtime `request_user_input` travels through Host, renderer projection, preload, store, and composer; options display, an answer is accepted, and the same Turn resumes exactly once. |
| AC-2 | If the original requested notification is dropped, a fresh renderer or reattached subscription recovers the live question without a new model call. |
| AC-3 | Switching Threads, hiding/reopening the dock, and repeated reconciliation preserve request identity and never show another Thread's question. |
| AC-4 | Reordered pending/empty snapshots and requested/cleared events cannot erase a newer question or resurrect an old one. |
| AC-5 | Interrupt, tool cancellation, normal/error Turn termination, and owner shutdown remove the matching form and settle the wait without inventing an answer. |
| AC-6 | Answer, Continue, or discussion racing with cancellation, double submission, or a lost acceptance reply produce at most one accepted response, one recorded discussion message where applicable, and one model resumption. |
| AC-7 | A waiting-state/snapshot failure shows Try again; the existing composer retains its execution controls without a duplicate Stop. Successful recovery restores the form or editor. |
| AC-8 | Host restart does not revive historical questions; renderer reload under a live Host restores the request and retains its original deadline. |
| AC-9 | Multi-step/Other answers, existing draft retention, focus, keyboard use, light/dark themes, and accessibility preferences remain functional. |
| AC-10 | The reported event order reproduces neither a waiting Thread with no recoverable form nor an idle Thread with a stale form. Diagnostics identify transition boundaries without recording question/answer content. |
| AC-11 | An omitted timeout releases an unanswered request after 60 seconds; explicit durations retain the 60-to-240-second bounds, and hiding/reloading the form or losing its notification cannot extend the deadline. |
| AC-12 | Timeout fences live submission and clears the waiting flag, returns a typed no-answer result, and resumes the same active Turn once without sending local drafts, selecting an option, fabricating text, or creating another Turn. |
| AC-13 | Answer versus deadline, delayed timer, system sleep/resume, cancellation, and late-response races yield one settlement; a stopped Turn is never revived. |
| AC-14 | After timeout the Agent can continue reversible independent work, retains genuinely required decisions as unresolved, and does not automatically re-ask the same question or treat silence as approval. |
| AC-15 | Automatic expiry while typing Other on a later step retains every edited step without Submit; hiding/remounting the form, Thread switching, and delayed snapshots do not lose that draft within the same renderer session. |
| AC-16 | After expiry or interruption, retained content expands at the original question in the transcript with native selection/copy and no action buttons. It never changes the ordinary message draft or emits a model call. |
| AC-17 | A newer request, late settlement, or lost acceptance reply never moves or deletes another request's draft. Reconciled acceptance releases only content actually included in that submission, retaining inactive text and newer edits; unavailable settlement retains content without claiming acceptance. |
| AC-18 | Timeout of a scheduled-run question removes its live form and active-question attention while preserving the same run and occupied foreground slot until actual execution settles. Unread results and unrelated issues remain unchanged; no timer or input owner is duplicated. |
| AC-19 | Navigation leaves unanswered questions local. Submit answers includes typed skips for them. Skip all ends the request from any step with only skips and retains every existing answer draft. Deadline/cancellation races settle once. |
| AC-20 | At 320 CSS pixels, all questions and actions remain reachable without horizontal scrolling. Light/dark, contrast, reduced motion/transparency, neutral states, and visible keyboard focus follow existing design guards. |
| AC-21 | A pending question directly replaces the composer even when it contains text. The hidden editor keeps its DOM, text, attachments, and draft; submission, Skip all, or settlement restores it unchanged. No preliminary choice or close/reopen switch exists. |
| AC-22 | Typing activates free text and selecting an option preserves inactive text. Previous/Next icons only navigate and are disabled at their respective ends. Submit answers is independent of navigation and available on any step, without a review screen or auto-submitting a selected option. |
| AC-23 | Submit answers includes earlier active answers. Skip all sends no answer content, uses continue intent, and retains both answer and ordinary message drafts. Neither route grants authorization. |
| AC-24 | Escape during a live question makes no model call and leaves the form visible. Ordinary Send/Steer after restoration sends only message content and cannot clear retained question drafts. |
| AC-25 | Injected ordinary Send failure retains its message and question drafts. Question submission failure or lost acknowledgement never clears the message draft. Explicit composite-API failure/replay remains exactly once. |
| AC-26 | Expiry while typing preserves the actual editor, caret, selection, IME, and scroll while disabling the expired tool route. New typing remains local. Blur or Escape after expiry shows the next pending question or restores the unchanged composer; a new request cannot interrupt active editing. |
| AC-27 | Empty outcomes create no note; each non-empty retained draft stays with its original question, even while a newer question is visible. Ordinary Send success or failure never deletes or changes this content. No transfer or draft-management controls remain. |
| AC-28 | Escape never answers, skips, or stops work. The existing composer owns Stop. The deadline is quiet without per-second announcements; outcome copy distinguishes acceptance, withheld content, timeout, and cancellation. |
| AC-29 | The question surface contains paired previous/next icons around progress, a scrollable question/answer body with Other, and two fixed footer actions. No close control, tabs, More menu, execution controls, or review page remain. |
| AC-30 | At 320 CSS pixels and with long wrapped questions, the header and footer stay visible. Selecting Other, typing, and moving between questions preserve form height and inactive drafts. Only the answer body scrolls. |

Extend the service test titled `round-trips request_user_input through the control
plane and active Thread flag`, codec/projection tests, renderer `ThreadStore`
tests, and the established multi-step input E2E. Add an integrated real-Electron
test with a scripted provider driving the actual tool; the existing E2E that
injects `userInput/requested` directly into the renderer cannot validate the full
delivery path. Test dropped events and renderer reload while the Host remains
alive, then cancellation and late replies with controlled ordering.
Use a controlled Host clock for deadline tests, plus one real tool-to-renderer
timeout smoke; include missing `autoResolutionMs`, explicit bounds, no form
delivery, multi-question partial drafts, and timer callbacks delayed by sleep.
Drive draft tests through actual keystrokes and IME, timer expiry without Submit,
form unmount/remount, a newer request, and ordinary Send and explicit composite API calls with
failure/retry. Verify local navigation, explicit Skip all, partial submission, free-text/option
switching, direct submission, and automatic restoration of the unchanged ordinary draft. Cover response-intent and discussion codecs, model projection,
canonical conversation records, attachment validation, and exact receipt replay.
Verify recovery preserves rich composer content and never emits an old-tool answer
or a model request on its own. The later scheduled implementation must run AC-18
through its shared owner and attention projection as well as the conversation UI.

Use sanitized synthetic fixtures matching the observed sequence, not committed
user conversations or machine-specific paths. Run typecheck, relevant
Core/renderer/E2E checks, `bun run docs:check`, and `git diff --check`; verify the
form/recovery state in light and dark. Fold specs and archive this plan only when
the complete feature passes its acceptance checks.

## Open questions

OQ-1: Which transport, subscription, or renderer transition lost the original
live notification? The event log and controlled replay establish admission and
two recovery/cleanup defects, but do not identify that transition. Investigate
with the bounded diagnostics and real delivery test in FR-9/AC-1; do not block
fixing the independently reproduced defects on speculation about a reload.

The bounded wait and existing maximum duration remain the selected constraint.
Accept its tradeoff explicitly: typing does not extend the deadline, and the
Agent may continue while the person finishes a local draft. The draft editor
preserves that work within the renderer session. Full reload or application exit
is outside the unsent-draft retention guarantee. The consolidated interaction
and discussion response contract form one complete feature; the diagnostic OQ-1
is not a start blocker.

## Implementation checklist

- [ ] Reproduce delivery, recovery/cleanup failures, and the missing-deadline case using synthetic fixtures (EVD-1 through EVD-4, AC-1/2/10/11).
- [ ] Settle snapshot/ordering, response intent/discussion, deadline, and independent draft-lifecycle contracts before their consumers, then implement the complete feature in one PR (FR-1 through FR-16).
- [ ] Implement direct question steps, independent message drafts, uninterrupted editing, and passive transcript retention together (DEC-2 through DEC-7).
- [ ] Verify AC-1 through AC-30 against the consumers present at implementation, investigate the original loss boundary, and fold the final behavior into current specs. Main owns the board/archive lifecycle; the later scheduled-work consumer owns its AC-18 integration fixture.
