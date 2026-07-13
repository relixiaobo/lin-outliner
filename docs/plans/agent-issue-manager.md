# Agent Issue Manager

## Goal

Replace Run-centered durable work with an Issue-first model that is clear to both
users and agents.

An Issue is the user-visible unit of work. It contains the goal, constraints,
acceptance criteria, verification policy, input scope, output policy, trigger,
Activity, and Agent Sessions that execute it. Repeated work is represented by a
Recurring Issue that materializes root concrete Issues when due.

Issue hierarchy is derived from execution origin rather than authored as an
arbitrary graph. An Issue created from a visible conversation is a root Issue. An
Issue created while an Agent Session is executing records that Session as its
origin and derives its parent Issue from the Session. Routable terminal outcomes
move one hop: a child wakes its direct parent Agent Session, while a root wakes
its origin conversation. Small internal steps stay inside the Agent Session Run
transcript, Activity, and final output rather than becoming durable child work.

## Non-goals

- Do not expose arbitrary parent selection in model-facing Issue tools; parentage
  is runtime-derived from the creating Agent Session.
- Do not expose Project, Task, Job, Run, Occurrence, or Logbook as durable work
  concepts.
- Do not keep legacy readers or migrations for previous pre-release Issue
  shapes.
- Do not make Dream ordinary Issue work; Dream keeps its protected runtime-only
  path.

## Design

### Core Concepts

`Issue`

- A durable root or child work item.
- Holds title, description, lifecycle status, delegate profile, relations,
  trigger, due date, recurrence context, completion criteria, verification
  policy, evidence, note links, input scope, output policy, execution policy,
  confirmation provenance, runtime-derived `parentIssueId` and origin when
  applicable, revisions, timestamps, and Activity.
- A root origin is a visible conversation. A child origin is the creating Agent
  Session. The model cannot supply, rewrite, or reparent either field, and hidden
  execution conversations are never routing origins.

`Recurring Issue`

- A reusable rule that materializes root concrete Issues.
- Holds title and description templates, cadence, time zone, missed-window
  policy, concrete Issue template, confirmation provenance, and next
  materialization time.
- Its origin is always a visible conversation, never an Agent Session. Generated
  Issues inherit that origin and link back through recurrence context rather
  than parent hierarchy.

`Agent Session`

- One execution, continuation, retry, or verification attempt for one Issue.
- Holds purpose, state, source, Issue snapshot, input/output snapshots,
  execution policy, continuation link, latest output, error, revisions,
  timestamps, and Activity.
- Internal breakdown such as "query each district" or "verify each source"
  remains execution-local and is visible through the Run transcript, selected
  Activity, and final output; it is not a durable Session field.

`Activity`

- The audit and user-visible history stream for Issues, Recurring Issues, and
  Agent Sessions.
- Records definition changes, status changes, comments, progress, questions,
  responses, errors, verification results, and output links.

### Durable Decomposition

When a user asks for a complex task, the main agent should create the smallest
durable Issue tree that matches independently executable outcomes. Short-lived
steps stay in one Agent Session execution.

Example:

- User asks: "Create one verified Beijing-and-Chengdu district weather report.
  Every district in both cities must be checked."
- Main agent creates one root Issue for the combined report.
- Its Agent Session may create two child Issues when the city queries need
  independent durable execution:
  - "Query Beijing district weather"
  - "Query Chengdu district weather"
- Each child description and criteria specify that every district in that city
  must be enumerated, queried, sourced, timestamped, verified, and summarized.
- Each child Agent Session keeps its district-by-district steps in its Run
  transcript and records results/evidence on that child Issue rather than
  creating one Issue per district.
- Each child completion wakes only its direct parent Agent Session. In this
  two-level example that is the root Issue's Session; with deeper nesting every
  level integrates its direct child's result before its own Issue can complete.
  The root Session integrates both city results, completes the combined report,
  and only then wakes the visible origin conversation through a hidden
  system-origin user turn. The original conversation Agent consumes that result
  in a new Run and decides whether to reply now, use tools, wait for another
  Issue outcome, or remain silent. Any user-facing response is a separate turn;
  runtime never splices the raw Session output onto the previous assistant turn.
  The conversation always shows the linked Issue terminal status, even when the
  Agent chooses not to reply.
- Root delivery is acknowledged when that notification Run reaches a normal
  final assistant `stop` and successful completion. Visible text is optional, so
  a deliberate silent turn consumes the outbox entry without retrying.
- Child results enter the parent as hidden runtime context. Durable delivery is
  acknowledged in the same Store transaction that completes the successful
  parent continuation and finalizes the parent Issue. The continuation must end
  with a normal final assistant response; verification-backed parents must also
  reach `verified`. Verifying, rejected, blocked, budget-exhausted, stale,
  provider-error, cancellation, and incomplete tool-turn states do not
  acknowledge delivery. Verification mode, the replacement attempt base, and
  ordered gap signatures survive restart; verifier Run ids remain graph-derived.
  Execution Sessions persist a controller role even when started from an active
  visible turn, so verifier rejection re-plans the same bound Run instead of an
  unbound sibling. A resumed continuation clears the previous span's submission
  pointer and can acknowledge with only the current span's final tool-free
  response or later submission. Session-owned execution chains never use generic
  Run notifications, OS banners, or `<detached-sub-run-results>` aggregation; the
  Issue outbox is their sole routing path. Internal conversation binding loss or
  missing, cyclic, or unreadable nested Run ownership metadata blocks Issue
  tools rather than falling back to conversation/global authority.
  A terminal execution-frame settlement re-queues delivery draining, and one
  earliest-deadline timer actively wakes deferred retries instead of waiting for
  the minute scheduler tick. Shutdown closes both scheduler gates, waits for
  scheduler-started Session launches, performs one final outbox pass, and then
  captures the conversation and Run-ledger writes produced by delivery.
  The parent Session cannot be stopped while a child or its terminal delivery
  remains outstanding.

Agent Session startup binds the newly allocated controller Run to its Session
before appending the first `run.started` lifecycle event. A failed binding aborts
the unannounced Run and cannot leave an orphan ledger. Objective or criteria
amendments durably invalidate the current verifier/re-plan frame and its verdict;
budget-only amendments preserve that verdict and objective state. Budget changes
are validated against the direct parent's remaining token reservation and
deadline before any verifier or contract mutation, and live execution timers are
immediately re-armed from the amended deadline. Resumed and
terminal lifecycle records repeat the latest objective, criteria, and role so
restart reconstruction cannot restore the pre-amendment contract. For a
verification-required execution, both `completed + active` and
`completed + verifying` remain active Agent Session states.

Cold-start recovery reconciles every active bound Session from its authoritative
Run ledger before classifying interruptions. Terminal Runs follow normal Session
synchronization and current-span result recovery; only missing or genuinely
non-terminal executions become `stale` and emit the one-hop startup error. A
same-process close with a live delegated execution frame instead retains the
conversation runtime headlessly. Reopening reuses that runtime, while a deferred
close destroys it only after the final frame settles.

Terminal routing is intentionally asymmetric:

| Event | Immediate destination | Issue state |
|---|---|---|
| Issue completes | Child -> direct parent Agent Session; root -> visible origin conversation | Completed |
| Child Issue is canceled | Direct parent Agent Session | Canceled |
| Agent Session errors, including interrupted-startup recovery | Owning Issue's immediate origin | Issue remains open for retry, revision, or cancellation |
| Agent Session is explicitly stopped | None | Issue remains open |
| Root Issue is canceled | None | Canceled |

Parent completion, cancellation, and replacement Session start are blocked while
any direct child is unfinished or any child terminal delivery is unacknowledged.
Completion and Session start are also blocked by unresolved `blocked-by` edges or
incoming `blocks` edges. Completed and canceled Issues cannot be reopened.
Conversation deletion is also blocked while the conversation is still an Issue
origin, a live Recurring Issue origin, or an execution carrier required by an
active child edge or pending delivery. Destructive conversation reset is blocked
while the conversation is an active Agent Session execution carrier. Closing the
visible conversation view is not deletion and follows the headless-retention rule
above.

The main agent's responsibility is to author a good Issue definition: objective,
scope, coverage, output shape, trigger, and verification criteria. It does not
need to pre-plan every execution step because the Agent Session will build that
plan from the Issue snapshot. This keeps the tool trace small, makes the Work UI
easy to scan, and gives the executor room to choose the right strategy. If each
district is truly independently user-visible work that should be managed
separately, the Agent Session can create child Issues whose results route back to
that Session before the root result reaches the user conversation.

### Tool Surface

The model-facing tools are:

- `issue_search`
- `issue_read`
- `issue_create`
- `issue_update`
- `agent_session_start`
- `agent_session_read`
- `agent_session_send_message`
- `agent_session_stop`

Issue tools operate on Issue definitions. Search filters and read includes expose
root/child relationships, while creation parentage remains runtime-owned.
The model-visible projection omits routing `origin` values and execution
snapshots. `issue_read` returns bounded Session summaries; `agent_session_read`
adds bounded Activity or latest output only when requested.

`issue_create`

- Creates either an Issue or a Recurring Issue. An Issue created inside an Agent
  Session automatically becomes a child of that Session's Issue.
- Runtime injects origin and parentage. A visible-conversation call creates a
  root; an Agent Session call creates a child; a Recurring Issue records only the
  resolved visible conversation so its materialized Issues remain roots.
- For complex work, the caller writes the full objective and acceptance criteria
  on the Issue instead of pre-materializing internal steps as separate durable
  work.

`issue_update`

- Updates Issue definition, lifecycle, trigger, criteria, verification,
  evidence, relations, input, output, permission, or execution policy.
- Does not reparent Issues; origin-derived parentage is immutable.
- `relations` connect independently user-visible Issues whose lifecycle is
  managed separately, such as true external blockers, duplicates, or related
  outcomes.
- Updates Recurring Issue cadence/template/lifecycle.

`agent_session_start`

- Starts or requests one execution or verification attempt for an existing
  Issue.
- Runtime eligibility still enforces archived/terminal/blocked/active-session
  rules.

`agent_session_send_message`

- Sends guidance or an answer into an active Session.
- Durable definition changes still go through `issue_update`.

### Work UI

The Work panel is Issue-first:

- Inbox: attention-needed work.
- Today: non-terminal when-ready work, active work, overdue or today-scheduled /
  due work, recurring rules firing today, and root Issues finished today.
- Upcoming: every non-archived recurring rule plus non-terminal future scheduled
  or due root Issues. A recurring rule may therefore appear in both Today and
  Upcoming.
- Logbook: completed, canceled, or archived root concrete Issues.

First-level rows show root Issues and Recurring Issues with a concept/status
marker, title, and one context-sensitive meta line. Child Issues are reached
through their parent hierarchy. Execution-local steps do not become Work rows.

Opening an Issue shows:

- title and status marker;
- timing/trigger line when useful;
- instructions;
- child Issues when present;
- generated Issues from Recurring Issues when relevant;
- one Activity timeline containing both Issue lifecycle entries and Agent
  Session execution entries.

An Issue opened from Work overlays this detail on the Work list. A terminal Issue
status opened from the chat transcript bypasses the list and overlays the same
detail directly on the current conversation; closing it returns to that chat at
the preserved scroll position. Nested Issue and Run transcript drill-ins retain
the originating surface rather than switching modes.

The transcript status row contains only a quoted Issue title plus its localized
terminal state, followed immediately by the same compact chevron used for process
disclosures. It has no leading Issue label or status icon. The durable
conversation notification therefore carries the raw Issue title for renderer
use, while Agent delivery context and OS notification copy retain their complete
terminal summary.

Agent Session execution entries are not a separate product section. They use the
same Activity row interaction as lifecycle entries and expand to a chat-style
`Process` disclosure backed by the renderer-only Session transcript reader;
process details are collapsed by default, with latest output or error shown in
the expanded execution body.

### Verification

Verification is an execution policy on an Issue.

- `agent-review` starts a verifier Agent Session when requested by runtime or
  tools.
- The verifier starts with no inherited conversation context and a read-only tool
  allow-list, then reviews criteria, evidence, Activity, linked Agent Sessions,
  and output.
- Runtime enforces the configured `requiredVerdict` and requires every
  `requiredEvidence` string to appear in the verifier result.
- Missing or malformed verdict lines fail closed; they never count as `partial`.
- Rejected or evidence-incomplete verifier results keep the Issue open and place
  it in the Work attention set.
- Passing execution or verifier evidence can complete the Issue when the review
  policy allows runtime completion. Human-review Issues enter Inbox after an
  execution Session completes and expose a trusted-user "Accept and complete"
  action in Work; an Agent cannot self-approve, weaken the review policy, or
  remove/waive an existing completion criterion first. Criteria ids and text stay
  bound to the execution snapshot; contract edits require a new Session, except
  for an explicit trusted-user waiver.
- Internal breakdown is verified through criteria/evidence on the same Issue.

### Permissions

Issue and Agent Session tools use the same runtime-owned authorization model as
the rest of the agent tool surface.

- The model does not pass user action ids.
- Runtime-owned authorization context decides whether a mutation or execution
  control action is allowed.
- An Agent Session can relate only its owning Issue and direct child Issues;
  pre-existing relations to outside that branch must remain unchanged.
- Creating unattended scheduled or ready work means the user intentionally
  created a durable trigger; runtime may execute it when eligible.

### Dream Compatibility

Dream remains excluded from ordinary Issue work.

- It is runtime-only memory processing.
- It runs in the protected Dream channel and keeps its existing tool whitelist,
  evidence exclusion, retention, and visibility boundaries.

## Open Questions

- Whether Issue criteria should gain a first-class structured checklist shape or
  remain the current text/evidence criteria.
