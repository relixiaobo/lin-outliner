# Agent Delegation Runtime

The delegation runtime is an internal execution engine. It is not a product
concept and it is not a model-facing tool family.

Current product work-management concepts are:

- **Issue**: durable work definition.
- **Recurring Issue**: durable recurrence definition that materializes concrete
  Issues at due time.
- **Agent Session**: one execution attempt against an Issue snapshot.
- **Activity**: append-only evidence and audit trail for Issues, Recurring
  Issues, and Agent Sessions.

The runtime may still create internal delegated execution records because the
existing event-log, transcript, verifier, notification, and isolated-skill
machinery are built around that executor. Agents do not start, inspect, steer,
amend, or stop those records through direct Run tools. They use Issue and Agent
Session tools.

## Boundaries

- There is still exactly one built-in assistant, **Neva**.
- Delegation creates same-agent execution workers, not independent personas,
  team members, or user-visible assignees.
- Direct delegated-Run tools are not in the agent tool catalog.
- The action catalog does not expose delegated-run action kinds.
- Tool-call UI does not special-case delegated-run tool names.
- Runtime actor names for this internal path use `internal_delegation`, not a
  model-facing tool name.

## Entry Points

Allowed runtime entry points:

- `agent_session_start` starts execution for an eligible Issue. Runtime maps the
  Agent Session snapshot into an internal delegation input.
- `agent_session_read`, `agent_session_send_message`, and `agent_session_stop`
  inspect or control the Agent Session surface. They may call the internal
  executor behind the boundary, but they never expose executor ids as the public
  control contract.
- Isolated skills use the internal executor to run skill content in a sidechain
  worker and return the final result to the parent skill invocation.

Not allowed:

- A model-facing tool that directly creates an internal delegated worker.
- A model-facing tool that directly reads, messages, amends, or stops an
  internal delegated worker.
- Compatibility profiles that re-enable retired delegated-run tools.
- Node-owned schedule, execution, or watermark protocols.

## Execution Model

An internal delegated worker has:

- a runtime record with status, objective text, criteria, context mode, budget,
  profile, parent linkage, and result/error metadata;
- its own event-log ledger and transcript;
- optional verifier workers;
- optional child workers created by runtime policy, not by a public tool family;
- terminal notification and Activity synchronization through the owning Agent
  Session.

The executor supports three context modes:

- `full`: copy the current parent context, closing unresolved tool calls with
  placeholder results before the worker prompt;
- `brief`: include a compact recent parent-context excerpt;
- `none`: start with only the worker directive and objective.

Explicit verifier Agent Sessions are runtime-pinned to `none` context and a
read-only tool allow-list.

## Issue Session Mapping

When `agent_session_start` is requested and eligible:

1. Runtime prepares the current Issue revision against the current document
   projection. Preview is non-mutating; request mode resolves symbolic output
   such as `daily-note` to a concrete destination. A preparation blocker creates
   one terminal error Session only for request mode and only while that prepared
   revision is still current, making scheduler failure visible without a
   minute-by-minute retry loop. A concrete child scope that exceeds its parent is
   rechecked atomically and recorded through the same failure path.
2. Runtime durably creates the Agent Session record with the prepared input and
   output snapshots.
3. Runtime resolves the Agent Session snapshot into a delegation input:
   objective, criteria, input scope, execution policy, profile, and verification
   policy.
4. The internal executor allocates the Run and child-agent harness in memory. An
   execution Session owns a durable `controller` role even when the Run is a
   child of the visible conversation turn that started it. Verification rejection
   therefore re-plans the same bound Run in place; it never creates an unbound
   sibling replacement.
5. Before any Run lifecycle event is written, the executor acceptance hook
   durably binds the Agent Session to that Run. Binding failure aborts and
   unregisters the unannounced Run, marks the Session as failed, and leaves no
   orphan Run ledger.
6. Only after binding succeeds does runtime append the initial `run.started`
   event and enter the child model loop. The worker must never reach
   `issue_create` without a persisted binding.
7. Once the binding exists, an `issue_create` call inside the worker can resolve
   the current execution chain back to the owning Agent Session and derive the
   child Issue's origin and `parentIssueId`. Missing internal bindings and
   missing, cyclic, or unreadable Run ownership metadata are fatal to Issue
   tools; origin resolution never degrades to visible-conversation/global
   authority.
8. Worker progress, result, failure, cancellation, and verifier verdicts are
   copied back to Activity and Session state.
9. The model continues to interact through Agent Session tools, not through the
   executor id.

## Decomposition

When an Agent Session worker needs to split work, it owns that execution
decomposition inside its Run transcript, evidence, Activity, and final response.
Issues may form an origin-derived durable tree. A worker creates a child Issue
only when it discovers a sub-outcome that needs its own durable lifecycle or
independent Agent Session; short-lived execution steps remain in the parent
Session execution. The worker cannot choose an arbitrary parent: runtime derives the
parent from the persisted execution binding.

This keeps the public work graph constrained. Durable ownership is root Issue ->
child Issues -> Agent Sessions, while ordinary execution breakdown is carried by
the Run transcript/output and criteria/evidence on the owning Issue. Child completion,
child cancellation, and child Session error return as hidden context one hop to
the direct parent Agent Session. Completion and error on a root return to the
visible origin conversation as a hidden system-origin user turn that starts a
new conversation-Agent Run. The Agent decides whether to reply immediately,
use tools, wait for another Issue outcome, or end the turn without visible
text. Any reply is a separate assistant turn; raw Session output is never
inserted directly as an assistant message. The hidden turn links to the durable
Issue notification projected as a compact visible status row. Explicit Session
stop and root Issue cancellation do not synthesize a result. A
child-delivery marker is acknowledged only when a
continuation descending from that marker ends with a normal final assistant
`stop` and reaches a successful `run.completed`. Verification-backed parent Runs
must additionally reach objective state `verified`; `verifying`, rejected,
blocked, budget-exhausted, provider-failed, canceled, stale, and incomplete
tool-turn states leave the delivery pending. The acknowledgement and any parent
finalization occur in one Store transaction.

A root delivery is acknowledged when its new conversation Run reaches a normal
tool-free final assistant `stop` and successful `run.completed`. Visible text is
optional: an empty `stop` means the Agent deliberately handled the notification
without replying and consumes the outbox entry exactly once. Provider failure,
cancellation, interruption, or an incomplete tool turn remains retryable. If
the final assistant stop is durable but the process dies before
`run.completed`, restart seals the same Run and acknowledges it without calling
the Agent again; an empty stop does not synthesize a result submission.

Only the current execution span can supply the acknowledged parent result. A
resume clears the prior submission pointer, and reconciliation chooses the
current span's final tool-free assistant response or later result submission.
Older "waiting" output cannot complete the parent after a child result arrives.

The entire execution chain owned by an Agent Session is excluded from generic
Run notifications, OS banners, and notification turns, including restore-time
interruption handling. Issue terminal-delivery outbox routing is the only result
delivery path: child outcomes go to the direct parent Session, and root outcomes
go to the visible origin conversation. A detached child with objective role
`controller` is also excluded from generic detached-child aggregation and never
appears in `<detached-sub-run-results>`. The parent may wait for that controller
to settle, but it continues only from the Issue outbox marker; generic aggregation
remains available solely for ordinary non-controller detached workers.

Terminal Run persistence precedes execution-frame settlement so overlapping
continuations cannot start against a frame still committing its result. Once the
frame settles, delegation explicitly re-queues the Issue outbox drain. Deferred
delivery deadlines are backed by one earliest-deadline timer, so a transient
provider failure or busy origin conversation retries promptly without depending
on the minute scheduler tick. On restart, a persisted `dispatching` claim also
arms that timer for the exact lease expiry rather than waiting for the next
scheduler sweep.

Process shutdown first closes both the Dream and Issue scheduler gates, then
drains their already queued tails, scheduler-started Session launches,
conversation appends, delegated Run-ledger appends, and Issue delivery retry
timer refreshes. A final outbox pass runs after scheduler-started launches settle
so a startup failure queued during shutdown is still delivered before their
resulting conversation and Run-ledger writes are captured. Scheduled or manual
Dream work and new Issue sweeps cannot be queued after that shutdown boundary.

Each child-delivery payload includes the child Session execution id. The parent
waiter matches newly started controller Runs to those identities instead of
comparing pending markers with the total historical controller count. Sequential
controller children therefore cannot strand a later delivery after an earlier
one was already acknowledged, including after restart.

Closing a visible conversation is distinct from process recovery. If a delegated
execution frame is still live, runtime retains the conversation and delegation
runtime headlessly instead of unsubscribing or discarding them. Reopening that
conversation reuses the same in-memory runtime and clears the deferred close; it
does not rebuild the worker from disk or classify it as interrupted. If the view
remains closed, the retained runtime is destroyed only after the final delegated
execution frame settles.

A parent Session cannot be canceled while child work or a child terminal
delivery is outstanding. Stop therefore reserves the Session durably before the
executor is called; the reservation blocks concurrent child creation, execution
binding, guidance, and another stop. Executor failure is reconciled against live
state: a confirmed cancellation commits; a confirmed live state or a concurrently
observed non-canceled terminal state releases the reservation; only an
unconfirmed state that remains live keeps it until startup recovery. Cold-start
recovery runs once per AgentRuntime process instance and first reconciles every
active bound Session from the authoritative Run ledger through the ledger-repaired
Run-meta projection. A terminal Run is synchronized through the normal execution
state path, including its current-span submission or final assistant fallback, so
a completed Run is not mislabeled as an interrupted Session. Only Sessions whose
bound execution is still running, missing, or otherwise genuinely non-terminal
remain for the stale pass. That pass clears abandoned stop reservations and marks
those Sessions `stale` while enqueuing their one-hop error delivery in the same
Store transaction. Same-process conversation reopen reuses the retained runtime
and never invokes this cold-start recovery. An unexpected executor
cancellation is also recorded as `stale`, rather than `canceled`, when child
edges still need that Session as their routing target.

Pending child delivery payloads survive Run compaction as exact durable
follow-up text. A post-compaction root can carry multiple pending markers, and
marker recognition follows the logical carrier through repeated compactions
instead of depending on the original message remaining on the active path.

## Scope And Continuation

An Issue Session Run has separate readable, existing-node writable, and
direct-child creation ceilings.
`resources.nodes` contains resolved input nodes, attached `noteNodeIds`, and any
output anchor. `resources.writableNodes` contains only output policies allowed to
mutate existing nodes. Creation outputs leave that list empty and put their exact
anchor in `resources.creatableNodeParents`; `node_create` may insert a direct
child there but may not mutate the anchor or its existing descendants. Input and
note nodes remain read-only unless the output policy independently names them.
Before every insertion, the node tool revalidates that an exact create parent is
active and remains an ordinary content container; moving it to Trash invalidates
the prepared authority, while a locked canonical day node remains usable.
An explicit empty array means deny all, while an omitted resource dimension is
unrestricted. Child Issue Sessions may narrow but never widen any parent
ceiling; an exact create parent does not imply create authority at an existing
descendant.

Runtime activation preflight rejects new active `saved-query` definitions and
destructive `replace-input` definitions without trusted per-Session
confirmation. Legacy saved-query work fails preparation visibly. `daily-note`
is prepared per Session into a concrete canonical day-node create parent; the
symbolic definition is never used as execution authority. A concrete Issue may carry one
absolute `deadlineAt`; runtime maps that exact timestamp into the Run budget
without minute rounding. Recurring Issue templates do not carry absolute
execution policy.

A continuation request chooses `summary`, `transcript`, or `none`. Summary injects
only the previous Session's latest output or error. Transcript injects a bounded
active-path Run transcript and explicitly falls back to summary when its binding
or ledger is unavailable. None injects no prior Session content. The Session
persists the previous Session link; intent, guidance, and context mode are consumed
when the new execution objective is built rather than stored as a second durable
transcript. Restoring a persisted Run rebuilds its live harness with the Run's
durable `scope` and `budget` before any continuation or re-plan starts. The
restored agent tool catalog and every nested runtime therefore retain the same
resource and budget ceilings as the original execution.

## Verification

Verification remains an execution policy, not a separate model-facing tool.

- A verified worker must have explicit criteria.
- Runtime may start verifier workers using the configured verifier profile.
- A verifier derives its resources from the concrete work Run, not the broader
  runtime inheritance scope. It preserves `docs`, `paths`, and readable `nodes`,
  removes write authority, and receives only tools admitted by the Run's
  effective allow-list and read-only capabilities. A write-only Run therefore
  gives its verifier no tools.
- Whether a delegated Run requires verification is persisted in Run metadata.
  Replacement Runs also persist their inherited attempt base and ordered gap
  signatures; direct verifier ids are rebuilt from Run parent links. Execution
  status and objective status are orthogonal: `completed + verifying` remains an
  active Agent Session, and `completed + active` also remains active when the Run
  still requires verification. A verification-disabled completion or
  `completed + verified` completes the Session; `blocked` and
  `budget_exhausted` become attention/error states, while `stopped` becomes
  canceled. Stopping an active verification state cancels the live verifier
  before Session cancellation is committed. On process restore, a
  `completed + verifying` parent with no live verification frame is durably moved
  to `blocked` with an interruption reason; it is never re-exposed as an active
  Session ghost.
- An objective or criteria amendment invalidates the current verifier/re-plan
  frame, stops its live verifier children, clears the previous verdict and gap
  state, and returns the objective to `active`. Late verifier, re-plan, or
  replacement outcomes are fenced by the lifecycle epoch and cannot overwrite an
  amendment or stop that already won the race. A budget-only amendment updates
  budget accounting without aborting verification or changing the current
  verdict, objective status, blocked reason, latest gap, or gap signatures.
  Budget amendments are fully validated before verifier invalidation or contract
  mutation, and child budgets cannot exceed the direct parent's remaining token
  reservation or wall-clock deadline. A live execution frame immediately re-arms
  its wall-clock timer from the amended deadline, including when the amendment
  adds the first deadline or shortens an existing one.
- Amendment persistence is ledger-authoritative. The amendment reminder and
  lifecycle update are appended together, and resumed or terminal lifecycle
  events repeat the current objective, criteria, and objective role. Run-meta
  repair therefore reconstructs the latest amended contract rather than falling
  back to the original `run.started` metadata after restart.
- Accepted verifier results are recorded as bounded Activity on the Issue, while
  acceptance and required-evidence checks use the linked verifier Session's full
  latest output. Missing or malformed verdict lines fail closed as `fail`, and
  the legacy `pass-or-partial` verdict spelling is normalized to `partial`, never
  to strict `pass`.
- A rejected worker can create replacement work when budget and livelock guards
  allow it.
- A pass verifier verdict allows runtime to complete the Issue. Human-review
  Issues remain open until an explicit lifecycle transition. Issue completion is
  always recorded through Issue state and Activity.

## Isolated Skills

`execution: isolated` skills use the same internal executor with a narrow input:

- objective is the rendered skill body;
- verification is off unless the skill flow explicitly adds it through ordinary
  work criteria;
- read-only isolated skills receive a read-only filtered tool set;
- the parent receives only the final result and durable output references.

The skill surface does not require, describe, or expose direct delegated-run
tools.

## Debug Surfaces

Internal delegated execution can still appear in debug and transcript views
because those views inspect runtime process state. Those views are diagnostic;
they are not the product work-management vocabulary and do not define agent tool
contracts.
