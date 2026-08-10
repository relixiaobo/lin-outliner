# Agent Subagent Threads

A Subagent is a child Thread. It is not a durable Agent object, membership
record, or special execution store.

## Lineage

`parentThreadId` records Subagent lineage. Root and descendants share a
`sessionId`. `forkedFromId` records history-fork lineage and is independent of
Subagent lineage.

Each child has its own catalog record, rollout, Turns, Items, active-Turn lock,
Goal, and extension state. Parent and child communicate through canonical Items
and a host mailbox; they never share mutable Turn history.

## Roles And Configuration

A Configuration Profile defines root execution defaults. An Agent Role narrows
or specializes a child execution. A Subagent is the child Thread created with
that resolved Role.

Child resolution applies the parent as a hard ceiling across every capability
source:

- model tools
- Skills
- plugins
- MCP servers

Role overrides may remove parent capabilities but cannot add capabilities the
parent did not have. Model and reasoning-effort overrides remain explicit child
configuration choices. Resume resolves the stored Role again and reapplies the
current parent ceiling and explicit blocks.

Built-in Roles are `default`, `worker`, and `explorer`. Project or user Roles use
the same contract and do not introduce a second kind of Agent identity.

## Collaboration Tools

The fixed `collaboration` namespace contains:

- `collaboration.spawn_agent`: create a child Thread and start its first Turn
- `collaboration.send_message`: queue a message without forcing a new Turn
- `collaboration.followup_task`: start work when idle or deliver at a safe active
  boundary
- `collaboration.wait_agent`: block until terminal child activity or steering and
  return batched child outcomes
- `collaboration.list_agents`: query the live descendant tree
- `collaboration.interrupt_agent`: interrupt a child's current Turn

Providers that require flat names receive the reversible `namespace__name`
encoding. Registry assembly rejects any collision before a tool reaches a model.

Task paths are host-session addresses such as `/root/research`. Their uniqueness
and lookup scope is one `sessionId`, so independent root Thread trees may use the
same path without conflict. They route live coordination and are not durable
entity IDs. Durable relationships use Thread IDs.

List and wait views are scoped to the sender's descendant subtree; sibling branches
in the same session are never returned. A wait blocks on active direct children,
because those are the Threads whose terminal transitions are delivered to that
sender. Descendant status remains visible, but a detached grandchild cannot leave an
ancestor blocked on an event routed to a different parent.

## Budgets

The runtime-wide `subagentTokenBudget` setting defaults to `1,500,000`; `null` disables
the shared default.

**Spend is request-scoped.** A pool belongs to the delegating Turn that opened it, not to
a Thread. A Turn that delegates with no inherited pool opens one, whether or not a budget
is configured: a null `tokenBudget` means *this request is unbounded*, not *this request
has no owner*. A nested delegation inherits the ancestor request instead of opening a
second one, so one request spans the whole tree it owns.
Ownership is a property of delegation and the budget is one optional attribute of the
owner — which is what lets Stop close a request that nobody put a number on. The grant is
fixed when the request opens, so enabling the setting mid-request does not retro-bound
work already delegated under it; the next request gets the new value. When a spawn finds
no inherited pool, the delegating Turn becomes the pool
holder, and every descendant spawned inside that Turn's subtree shares it; a later Turn
that delegates again opens its own pool. What the breaker defends against is runaway
recursion inside one request, so "how much this conversation has spent over two weeks" is
not an anomaly signal and is never accumulated as one. Restating a need is therefore a
real recovery path: a new user Turn always delegates against a fresh grant. Structural
limits do not follow spend into request scope — depth and the direct-child count below
stay Thread-lifetime, because they defend against topology and topology is a property of
the conversation.

Each spawn records a membership row naming its pool, if any, and the delegating Turn that
owns its spend. A child spawned before its request had a pool joins that request's pool
when one is created, and never a later request's — migrating a live child onto a budget
the user never spent on it is exactly what request scope exists to prevent. Resolution is
the membership binding first, then a guarded ancestor walk for a Thread whose own row is
missing. Later setting changes affect only new requests, while interrupt remains the
control for a live one. The
top-level spawner's own Turns never debit or gate against the pool it opened; a capped
child member is covered by its own membership.

**Stop closes the request.** A user Stop — from the composer, from a delegation
row, or from a child Thread's header — settles the addressed Turn and every member of
that request which is a descendant of the addressed Thread, then marks the
request closed. Addressed at the delegating Turn that owns the request that
predicate is every member, so the composer needs no separate rule; addressed at
one child it is that child's subtree, because its own descendants would
otherwise keep running with an interrupted consumer. Only a Stop addressed at
the request's originating Turn closes the request; a per-child Stop leaves it
open, since the delegator is still running and may legitimately delegate again.
Membership is the lineage closure of the Turn's own members: `originTurnId`
records one hop, so a grandchild names its parent's Turn, and stopping only the
per-hop set would leave it running with an interrupted consumer. Closure rather
than pool membership, because a capped child binds its spend to its own pool
while the request that spawned it still owns it.

A closed request refuses new delegated work at the same single admission gate
the budget uses, so the user bright line holds unchanged — a user-triggered Turn
never reaches that gate. Refusal never terminalizes a Turn and therefore adds no
`Turn.error.code`; members that were running are interrupted by the same Stop
and settle as `interrupted`. Queued work held by a member being settled is
dropped, because work the user stopped must not reappear inside a later request;
the `send_message` call that queued it remains in the sender's transcript, so it
can be sent again. A closed request is retained rather than reclaimed — dropping
it would erase the fact that the user stopped this work — and is removed with
its Thread subtree. Re-delegating to one of its children binds that child to the
new request, which is how stopped work is legitimately resumed.

**Pool lifetime.** The pool outlives the Turn that opened it: a fire-and-forget child
keeps charging the request that asked for it after that Turn has already returned. It is
reclaimed once its originating Turn has ended and no member Thread is still running,
whichever settles last. Reclamation removes the pool row and unbinds its members, which
keep their rows: a local cap is a per-Thread lifetime constraint that must outlive any one
request, and the recorded contribution is the only remaining account of what that child
spent. Re-delegating to an idle child whose pool was reclaimed — a `followup_task` or
message that starts new work — binds it to the pool of the Turn delegating now, by the
same rule that binds a fresh spawn, so no descendant Turn runs uncovered.

The user-triggered Turn
bright line is an admission-level defense-in-depth invariant, not a product journey:
children have no composer, so recovery from exhaustion is parent respawn or synthesis
plus the preserved transcript artifact.

`collaboration.spawn_agent` also accepts optional `max_total_tokens` as a positive safe
integer, honoured only at or above a fixed 1,000,000 floor. A smaller value is
DROPPED, not raised: any honoured cap detaches the child into its own pool, so
raising a small one would hand every capped child a private million-token budget
and step over the `subagentTokenBudget` the user configured. Dropping it returns
the child to the request's shared pool, which is the ceiling the user actually
set. The value is validated before the floor is considered, so a malformed
argument still teaches the model what it sent. A model guessing at a cap guesses
low, and caps in the thousands starved children mid-answer. It is a per-child cap on that Thread's own contribution inside the shared pool,
not a grant, reservation, nested pool, or refundable allocation. Omitting it creates no
child-local cap. When no ancestor pool exists, an explicit cap creates a pool of that
size anchored at the new child; its descendants join the same pool. Collaboration and
isolated Skill children use the same spawn boundary and accounting rules.

The default is a circuit breaker, not a task allocation. Local usage spans roughly
12k-432k total tokens for legitimate child work (94k median), while the observed runaway
was 682k, so a tight cap would not reliably separate useful work from anomalies. The
1.5M threshold is deliberately generous, around three times the heaviest observed
legitimate child. Budget accounting uses `totalTokens`, including cache reads; no
per-Role or per-Skill defaults alter the global setting.

Budget intent follows this ladder: an explicit user directive in the prompt, the parent
model's per-spawn `max_total_tokens`, future data-driven Role or Skill caps, then the
global pool default. The explicit value and global value are different constraints rather
than overrides: admission and in-flight enforcement obey whichever has less remaining.
Role and Skill caps remain deferred.

`SubagentBudgetLedger` stores one pool row per holder — keyed by the delegating Turn, or
by the capped child for an explicit cap — and one membership row per spawned child.
Persistent rows live in `subagent_turn_budget_pools` and `subagent_turn_budget_members`
beside Goals in `goals.sqlite`; ephemeral rows mirror them in memory. The per-child
`thread_budgets` and Thread-keyed `subagent_budget_*` formats are deleted, not migrated or
read. Deleting a descendant removes only its member row and never refunds usage. Deleting
the Thread that originated a pool deletes the complete Thread subtree and that pool plus
all remaining member rows. A separate lifetime spawn counter survives child deletion and
is removed only with its spawner. The ledger has no model-tool surface; child Goals remain
independent and cannot replace, remove, or raise these host-owned limits. Coverage does
not depend on a pool binding: a child spawned before its request had a pool still gates and
debits the pool its own delegating Turn later creates.

One guarded resolution is authoritative for spawn binding, admission, in-flight
enforcement, accrual, and views: the membership binding, healed to the member's own
delegating Turn, then an ancestor walk. Member rows record contribution, the owning Turn,
and optional cap state, not an independent pool assignment. If a stored member binding
disagrees with that resolution, the host re-binds it and writes a budget audit entry.
Read, re-bind, accrual, and pool-reclamation failures audit and degrade without changing
Turn status; only pool/member creation remains a fail-closed write boundary.

Spawn reads the default setting before entering the Thread-tree mutex. Inside that mutex,
role/configuration resolution, child creation, and inherited-context copying precede
budget-row creation. If later Turn admission fails, rollback deletes exactly the member
and pool records created by that spawn before releasing the mutex; it never deletes rows
by a shared pool key. Thread-entity cleanup follows outside the mutex. An earlier sibling
therefore survives a failed spawn, and a concurrent spawn can proceed only after rollback
has restored a coherent ledger.

When either the shared pool or the target child's local cap is exhausted, the single
Turn-admission boundary rejects every new non-user trigger with
`SubagentBudgetExhaustedError`. A delegator whose request pool is exhausted also cannot
spawn another child into that request; its next Turn delegates against a new pool.
Collaboration follow-up and message tools surface the complete typed error to the parent.
Steering an already-active Turn remains unconditional; the gate protects new-work
admission only, so a parent can still steer an overshooting child to conclude.

`followup_task` snapshots and removes the current mailbox synchronously before awaiting
admission. Messages queued during that await remain in a new mailbox entry. If admission
is refused, the snapshot is prepended to the new entry; if admission succeeds, only the
snapshot is consumed and concurrently queued messages remain for the next Turn.

Idle-only callers receive the typed refusal rather than a soft `null` result.
`GoalExtension` records the complete error as its continuation deferral reason, while
`AutomationDispatcher` marks the run failed with the same accurate model-facing message.
A renderer Turn carries `{ kind: 'user' }` and is never budget-gated; descendant usage
still accrues to its member and shared pool. This is a defense-in-depth invariant only.
Because descendant Threads expose no composer, user-facing recovery happens in the
parent through respawn or synthesis and the preserved transcript artifact. Self-managed
Goals never control this gate.

Completion accrues usage inside the per-Thread mutex before the active Turn is removed
or idle status is exposed, so racing admission observes the committed total. Failure
finalization also accrues any execution usage already returned by the executor. A hard
process crash can still lose usage that existed only in the in-flight process. On every
completion or failure path, accrual and total settlement of that Turn's in-memory
contribution are adjacent synchronous operations with no await between them. Settlement
clears both the shared-pool tally entry and the per-Turn counter used by local-cap views,
so no observer can see committed usage and the same live contribution at once.

At the start of every descendant Turn, the lifecycle installs a runtime usage observer.
`PiEventNormalizer` invokes it immediately after accumulating each assistant
message's `totalTokens`; Turn diagnostics remain inspection-only and have no accounting
role. A non-user descendant Turn also receives the native-kernel budget port. Each read
re-runs the authoritative walk, re-reads persisted pool usage, and adds the in-memory
tally from every active Turn in that pool, including the current Turn. The port returns
authoritative `remaining` plus the currently binding constraint's `used` and `total` for
warning/error text. If the child's local cap has less remaining, that cap is the binding
constraint.

The executor does not add its normalizer total to the port result, and the kernel never
subtracts one snapshot from another. It interrupts only when a later read reports
`remaining <= 0`, so a mid-Turn switch between pool and cap denominations cannot create
a false exhaustion or disable the tighter cap. Concurrent siblings can overrun only by
one provider call each instead of independently spending the full pool.

Explicit user Turns receive no budget port or warning callback, preserving the bright
line, but every descendant user Turn still receives the runtime usage observer and
accrues on completion. While a descendant is uncovered, the observer records usage
locally and the non-user port returns `null`. If a later spawn creates an ancestor pool
while that Turn is active, the recorded contribution joins the live pool tally
immediately and completion debits the same pool. The first provider call is always
admitted; an already exhausted fresh non-user Turn belongs to the admission gate.
Reaching the live remainder settles genuinely outstanding model work as `interrupted`
with the model-facing token-denominated error. The admission gate owns later non-user
work.

The exhaustion check runs before steering is drained and before a new `turn_start` is
emitted. If the preceding assistant message is terminal, the Turn remains `completed`
and racing steering remains undelivered even when the budget was exhausted; overshoot
still accrues. Only a boundary with outstanding model work can be interrupted, and every
emitted kernel Turn boundary remains paired.

On the first later-call boundary where the binding constraint reaches 80% consumed,
the host admits one steering input through the ordinary canonical steering path:
`[Budget notice] ~80% of the token budget is consumed (<used> of <budget>). Synthesize
your findings and conclude now.` The notice is a real `userMessage` Item, appears in
diagnostics as steering, and reaches the next provider projection. It is emitted at most
once per Turn; no private prompt overlay or synthetic non-canonical message carries it.
The displayed values are the actual controlling pool-or-cap values at the crossing,
never reconstructed threshold values. Delivery failure is advisory: the kernel
logs it and continues without changing Turn status. Diagnostics mark accepted steering
as consumed only after the runtime drains it into a provider context. A top-level pool
holder provides neither an execution port nor a usage observer for its own Turns.

Collaboration spawn admission also enforces two fixed legibility limits: `/root/a/b` is
the deepest task path, so a depth-2 Thread cannot spawn a collaboration child; and one
Thread may create at most 16 direct collaboration children across its lifetime. The
durable count cannot be reset by deleting a child. Isolated Skill children are leaf-only,
host-created work and are exempt from both gates and the count. The constants live beside
the budget ledger. Both checks run inside the Thread tree mutex and throw distinct typed
errors whose messages name the relevant limit.

`list_agents` and the child tree returned by `wait_agent` expose the boundary that would
refuse the child's next non-user Turn. They normally report shared-pool state, where
`tokenBudget` is the pool total and `tokensUsed` is total live pool spend. When a local
cap has less remaining, they report that cap and the child's live contribution instead;
a legacy cap-only member does the same. A child no pool bounds reports a `null` budget
with its own recorded contribution, so a request that has ended is still accounted for
rather than reading as a child that did nothing; one that never spent anything reports
`0` and `null`.

Token quantities are system-internal. Parent-model tools, warning steering, typed errors,
and diagnostics remain token-denominated. Terminal Turns carry stable
`subagent_budget_exhausted` or `subagent_structural_limit` error codes. Transcript errors,
Turn Details, copied error text, and Automation run errors classify budget failure by
code and translate it into localized resource-limit copy stating that results were
preserved; they never render token counts. `Turn.error.code` accepts only
`runtime_failure`, `host_restart`, `subagent_budget_exhausted`, or
`subagent_structural_limit`; unknown runtime or decoded strings normalize to
`runtime_failure`.

## History And Activity

Spawning records a `collabAgentToolCall` in the sender and a
`subAgentActivity` `started` Item in the sender's active Turn. That started Item
carries `spawnItemId`, the id of the tool call that delegated — the `skill` call
or the collaboration spawn call — so the renderer can present one delegation as
one row at its cause's position. Terminal activity records `null` there: it can
be flushed into a later parent Turn, where the delegating call is not among the
Items and naming one would claim an unrelated row. The field is additive and
nullable on decode: an activity persisted before it existed reads as `null`
rather than failing, because the no-migration policy covers dev userData and not
the packaged app's daily-use data, which no release step wipes. Child terminal
status queues a parent-scoped `completed`, `interrupted`, or `errored` activity
Item bound to the exact child Turn; the Item copies that Turn's complete typed
`TurnError`, while a started or successful activity carries `error: null`.

Every delegated form produces those Items, not collaboration alone: an isolated
Skill child is a child Thread doing delegated work, so the parent shows the same
per-child row with live status, elapsed time, and a way in, instead of one
in-progress `skill` tool row standing for the whole run. Only the collaboration
form is deliverable through the collaboration result channel — a queued Skill
activity never ends a `wait_agent`, never appears in its outcomes, and never
wakes a parent blocked on collaboration children, because the invoking `skill`
call is already the single parent-facing owner of that outcome. A parent-visible
row and a deliverable result are separate questions.
`collabAgentToolCall.agentsStates` persists each reported child's status together
with nullable task path, nickname, and Role so its identity survives catalog
deletion. This is a historical result snapshot, not a second source of live
execution truth. The queue is flushed into the active parent Turn while it waits, before a
new parent Turn reaches the provider, or before an active parent Turn becomes
terminal. If no parent Turn is active, the activity remains pending for the next
one. Child output remains in the child rollout. Parent-visible summaries are
Items, not copied child history.

The renderer also consumes the canonical child `turn/started` and
`turn/completed` notifications it already receives. It retains only the latest
Turn DTO per Thread when child history is unloaded, allowing the parent row to
reflect a terminal child before the parent-side activity queue is admitted.
Persisted terminal parent activity remains authoritative after reload; the
renderer cache is cleared with rollback, subtree deletion, and a catalog reload
that omits a root Thread, and is never persisted as another execution record.
A reload cannot clear a child that way, because the list returns roots only.

Waiting is interruptible and uses a pending latch scoped to the sender Thread. It
has no model-controlled polling timeout: while a child is active, it returns only
for sender steering or direct-child terminal activity. If no child is active it
returns immediately. One return drains every terminal activity already queued,
includes each child's completed final result and error, and also includes the
current child-tree status. This makes one blocking wait after fan-out sufficient;
the parent synthesizes completed outcomes instead of polling or repeating covered
work. Each queued outcome is bound to the exact child Turn that emitted the terminal
transition; starting a follow-up cannot replace the queued result with newer child
state. Activity that arrives immediately before the wait is retained, and unrelated
Thread activity cannot wake it. Interrupt changes only the active child Turn and
retains the Thread for follow-up work.

If terminal activities were admitted before the current Turn, an idle wait returns
the terminal outcomes from the current child tree so the result remains recoverable
without copying child history into every parent Turn. The completed wait tool result
then becomes the durable parent-side record of the delivered findings.

An isolated Skill uses the same child-Thread mechanism with a bounded tool
catalog, but not the collaboration result channel. Its child is absent from
`list_agents` and `wait_agent`; the invoking `skill` tool is the single parent-facing
owner of its outcome. This prevents one completed Skill result from being replayed
again as collaboration work. Its model-facing catalog description states the
single-child execution contract and whether the declared tool ceiling excludes
Subagent spawning. A completed isolated result is framed as work product for direct
synthesis, not a request to repeat the task. Read-only isolation is a catalog
constraint, not an operating-system sandbox.

## Inherited Context

`collaboration.spawn_agent` accepts `fork_turns=none|N|all`, where `N` is a positive
integer and the default is `all`. Selection starts after the parent's latest
`contextReset`. `none` adds no parent history, `N` selects the last N eligible Turns,
and `all` selects the complete current epoch. If a selected compaction references an
earlier cursor, selection expands to keep that cursor reachable rather than emitting an
invalid partial boundary. The same minimal dependency expansion applies when the selected
tail begins with a Skill or Role catalog delta: inheritance includes enough preceding
Turns to make that journal reducible. The payload still records the user's original `N`
as `requestedTurns`; dependency closure is not a silent change to the request.

Spawn during an active parent Turn snapshots the completed canonical prefix immediately
before the spawn call. The spawn call itself, in-progress Items, transient Plan state,
and retry notifications are excluded. The prefix becomes a typed `inheritedContext`
payload before the child's first user Item, retaining user content, evidence, assistant
content, reasoning summaries, complete tool exchanges, images, attachments,
compaction/reset semantics, the source Thread ID, and the exact covered-through cursor.
It is model context, not a duplicate visible child transcript.

Before child admission, main republishes the payload and copies every available nested
context, resource, and complete-output dependency into child ownership. Content-addressed
references and payload digests remain stable; only ownership changes. Missing inspection
payloads remain referenced and project as typed degradation evidence rather than blocking
child admission. Recursive payload classification feeds retention independently: a
child's inherited tiered originals and observations remain pressure-reclaimable while
generic and durable dependencies, including ordinary managed images, stay protected. The
child therefore remains projectable and its available managed images remain previewable
after the parent Thread is deleted.

Inherited payloads are reducer input, not projector-only message bundles. Skill and Role
catalog reduction, active inline Skill recovery, user-view baseline selection, and
file/Node observation recovery recursively consume their effective typed Turns. A child
compaction checkpoints those inherited states with child-owned references; a later
compaction consumes the prior checkpoint, so repeated compaction does not silently drop
the inherited state. Conflicting frozen projections or unavailable nested dependencies
degrade with explicit model-visible evidence.

Although the inherited Item and the child's task share the first active Turn, they are
separate budget units. The protected active boundary starts at the first current
admission Item after the leading inherited payload. Preflight or provider-overflow
recovery may therefore cover that inherited Item with exact same-Turn cursors while
preserving the current environment, view, catalogs, resources, Skill guidance, and user
task verbatim.

The child's first ordinary admission plans its Skill and Role journals against the
staged inherited evidence. An unchanged current registry emits no duplicate baseline or
delta, while a registry added or changed since the inherited boundary appends the normal
deterministic delta. This keeps the provider prefix stable without hiding newly available
capabilities from an old or long-running conversation.

Role discovery uses the same canonical journal shape as Skills whenever
`collaboration.spawn_agent` is available: one bounded built-in/project/user baseline per
epoch, no evidence for an unchanged registry, and appended added/changed/removed deltas
for an existing conversation. Compaction validates and checkpoints the announced Role
identities; `/clear` causes a fresh baseline on the next ordinary admission. The catalog
informs model selection but never widens the parent's capability ceiling.

## Delegation Contract

Every delegated unit of work — a collaboration Subagent, an isolated-Skill
child, and any future executor form — owes its delegator three products. Each
has fixed access economics and a fixed currency per audience. New
subagent-adjacent designs are evaluated against this contract first: name the
layer, then obey its economics.

**1. Result (pushed, free to the delegator).** The conclusion. Delivered in
the terminal outcome (`wait_agent` / `CollaborationTerminalOutcome.result`,
isolated-Skill result envelopes) without the delegator asking. Shipped
(#444, #446).

**2. Account (pulled, reader-pays).** The process behind the conclusion, as a
readable projection. Access consumes the READER's context, never the child's
budget, and never depends on the child being alive or under budget —
verification must be possible exactly when results are most suspect. Canonical
storage stays envelope/content-addressed (cache-stable bytes, ownership copy,
pruning); readability is a property of the read surface, not the store: at
terminal state the host materializes a bounded, self-contained transcript
projection consumed through the existing file tools. No dedicated reading tool
is added (tool-count vigilance: new tools require that no composition of
existing capabilities covers the need). Shipped (#460), with the human account
surface (task panel transcripts, Model Interactions) already shipped. The
mechanism is specified below.

### Account layer: the transcript artifact and the operator dump

**One faithful renderer.** `thread/TranscriptRenderer.ts` is the ONLY faithful
projection of canonical Turns into readable text, and it is the authority every
later faithful-text need routes through. `renderTurn` renders exactly one Turn
and reads only that Turn's payloads; `renderTranscript` composes it and is
byte-identical to a header plus one append per Turn — the unit of rendering is
the unit of appending, by construction. Both are pure over Turns plus an
injected payload reader (no store imports, no I/O). Per Turn: a header
(ordinal, status, duration, model, usage) then the Items in canonical order —
user and steering input verbatim, assistant text, reasoning summaries, tool
calls as `name(args) -> output`, and evidence/reset/compaction as one-line
markers. Two detail levels: `brief` (the artifact) and `full`, which adds Item
ids, payload digests, per-provider-call usage, and raw reasoning for forensics.
Every field is bounded by the persistence caps (`MAX_PERSISTED_*`) with an
explicit `[truncated N bytes]` marker, so the projection is bounded exactly
where the canonical record is bounded and a reader can tell a short answer from
a cut one. Tool-image identity comes from `ContextProjector`'s
`dynamicToolImageIdentity` — the same line the provider sees, never a second
copy of it.

**Compaction's summary is exempt on purpose.** `deterministicSummary` in
`context/ContextCompaction.ts` is lossy by contract — one line per Item, clamped
to a context budget, for a provider audience that must forget detail. The two
must not be unified: this renderer keeps whatever the store kept, that one must
shrink.

**Artifact: app-owned, append-only.** The file is
`<userData>/thread-transcripts/<threadId>.md`. Storage is app-owned and never
the workspace — git never sees a transcript, so there is no gitignore to
maintain, no workspace `file_glob`/`file_grep` noise, and no path by which a
secret echoed into a tool output becomes a committed file. The parent still
reads it with the existing `file_read` / `file_grep`: the capability layer
resolves absolute paths, so an app-owned location costs no new tool and no
permission change. The Thread id alone names the file — globally unique and
derivable from the Thread record, so cleanup and tooling can always reconstruct
the path. Startup reclaims the pre-rename `subagent-transcripts` directory by
**moving** its artifacts under the current root and then dropping the emptied
directory. Reclaiming it is necessary because once nothing computes that path,
neither the deletion cascade nor the orphan sweep can reach inside it, so
anything left there would outlive the Thread it belongs to with nothing able to
remove it. Moving rather than deleting is equally load-bearing: this is
`userData` a released build wrote, a completed Thread never appends again, and
so nothing would ever rebuild what a delete destroyed. The relocation runs
BEFORE the sweep, which then reclaims exactly the relocated artifacts whose
Thread is gone. A file that cannot be moved leaves the directory non-empty and
the next launch retries (A11); the current root wins any name collision, since
what this build wrote is the live artifact.

**One writer, one predicate.** `thread/ThreadTranscriptWriter.ts` owns the
cursors, the per-Thread append chain, recovery, deletion, and the orphan sweep
for EVERY Thread kind that keeps an account. Whether a Thread keeps one and what
its artifact's header says are a single injected answer, `resolveSubject`: null
materializes nothing, an object is the header. The subject is resolved once, when
the Turn is enqueued, and carried down the chain — the two must not become two
independent lookups again, which is what they were (a `parentThreadId` check at
enqueue, a spawn-edge lookup at append) and the shape two answers eventually
disagree in. `ThreadService` composes it in one place, in order: the user's
exclusion first (a Thread taken out of the records keeps none, whatever it is),
then the delegated form (`SubagentCollaboration` owns spawn metadata, so it
answers for a child), then any persistent root. The root branch carries no
per-kind knowledge — a root that is not ephemeral keeps a record whether it is a
user conversation, an Automation run, or a source that does not exist yet — and
ephemeral is what keeps the hidden internal Threads out. Because the root branch
is roots only, a child whose spawn edge is gone is not silently promoted into
one. The header omits whatever a Thread kind leaves unset, so adding a kind
cannot change what an existing kind renders; a root's `name` is the one it had
when the file first said something, since a header cannot be revised once the
artifact has grown past it.

**The index.** `thread/ThreadTranscriptIndex.ts` maintains one greppable
`index.tsv` beside the artifacts: a comment naming the columns, then one
tab-separated row per recorded Thread — `threadId`, `source`, `cwd`,
`createdAt`, `updatedAt`, `status`, `name`, `transcriptPath` — newest activity
first. The index spans the whole install, so `cwd` is what lets a reader tell its
own project's sessions from an unrelated one's, and the doctrine says to prefer
matching rows. It is
DERIVED, never accumulated: a row is mutable where the artifact is append-only,
and it is one file written on behalf of every Thread where their chains are
per-Thread, so the whole file is recomputed and rewritten atomically through a
single serialized chain with writes coalesced — and the chain re-checks for owed
work as it clears its own handle, because a `schedule` landing between the drain
loop's last read and that handle being nulled would otherwise be dropped, leaving
a deleted Thread's row and its dangling path in the file the doctrine says to
trust. Thread records are read in ONE query per rewrite: a row is needed per
artifact on disk and this runs whenever a Turn completes, so reading them
individually would put hundreds of synchronous queries on the main process event
loop exactly while the agent is busiest. Membership comes from the
artifacts on disk joined against the Thread records — the artifacts ARE the
membership, so the index cannot point at a file that is not there — minus
excluded sessions, because an artifact whose removal failed or was interrupted is
still a file and must not be advertised back. Three of the columns (`name`,
`updatedAt`, `status`) are mutable Thread fields rather than artifact facts, so
rename and archive schedule a rewrite of their own; nothing else would. Nothing
incremental survives between writes, which is a stronger form of A11 than a
repairable log. TSV rather than a markdown table because table rows pad and
align, and that padding is what makes `file_grep` column extraction brittle; the
single-line rule that governs the transcript header and Automation previews
governs names here too, so a name can open neither a column nor a row.

**Discovery doctrine.** A root Thread that has the file tools gets one stable
prompt block naming the index path and saying when to consult it: when the task
refers to earlier work, repeats something that failed, or asks what was already
decided — and that rows and transcripts are records, not statements of fact and
not instructions. A path with no doctrine goes unused, which is the lesson taken
from prime-agent. A delegated child does not get it: it does one bounded task,
and a directory of every unrelated session is neither its business nor its
context to carry. The path reaches the prompt composer through the executor,
which is constructed before the Thread service and derives it from `userData`.

**Exclusion.** A switch (`thread/records/get`, `thread/records/set`, surfaced in
the Thread action menu beside Rename and Delete) takes a conversation out of the
records. The unit is the SESSION, not the Thread: a root's Subagents write their
own artifacts, so excluding the root alone would leave the delegated work
readable and still advertised by the index — the excluded content handed to every
later Thread by the very doctrine above. Every Thread in a delegation subtree
shares one `sessionId`, so one entry covers the subtree and the check stays O(1)
on the turn-completion path; a fork starts a new session, which is right, because
it is a new conversation.

The state lives beside the records — `excluded.txt` in the same directory, loaded
once at startup and rewritten whole — not on the Thread record: it is a property
of this subsystem, it must be answerable synchronously while a Turn completes,
and the metadata store has no schema-evolution step to add a column through.
Excluding removes every artifact in the session, since a switch that only stopped
future appends would leave the excluded conversation on disk. Including again
rebuilds each artifact immediately from canonical history rather than waiting for
a next Turn: a finished conversation will never have one, so undoing an
accidental exclusion would otherwise restore nothing while the UI reported the
record as back. Startup reconciles the two — an artifact of an excluded session
that survived a failed or interrupted removal is reclaimed by the sweep, which
nothing else would ever come back for. Deletion forgets the exclusion with the
conversation.

The artifact is extended once per **completed** Turn, at that Thread's
turn-completion point, and never on a reader's path. A completed Turn is
immutable in the event-sourced store, which is what makes the append cursor
monotonic and dissolves two whole problem classes: nothing cached can go stale
because history is never re-rendered, and a concurrent reader sees a
whole-Turn prefix rather than a torn file. A Turn still running is simply not in
the file yet; steering and messages remain the live-interaction surface.
Appends are serialized per Thread so Turns land in completion order.

**Recovery.** The in-session cursor records which Turns the file already
contains, how many, and how many bytes that produced. When the cursor is cold
(process restart mid-child) or disagrees with the file's size, the artifact is
rebuilt once from the completed Turns through `atomicWriteFile` (tmp+rename, so
readers see old-or-new and never a partial file) and appending resumes.
Deduplication is by Turn membership, not by "was this the last one": a rebuild
folds in every completed Turn, so Turns still queued behind it are already on
disk and re-appending them would duplicate blocks under wrong ordinals.
Artifacts stay disposable and rebuildable: canonical truth is the rollout log and
the payload store.

**Contract surface.** `CollaborationTerminalOutcome.transcriptPath` carries the
absolute path, and `wait_agent` stays result-first: it renders nothing, and only
reports whether the artifact is on disk after waiting on the child's own append
chain. Every such wait is deadline-bounded, and on timeout the in-session cursor
decides the answer: A12 covers a filesystem that throws, but a wedged one would
otherwise park the delegator's Turn indefinitely — exactly the outcome A12
exists to prevent. A stalled volume costs the account layer accuracy, never the
delegator its result. Isolated-Skill children use the identical location, renderer, and write
model, and their result envelope carries the same path — the contract applies
uniformly to every executor form. A standalone Automation Thread's account is
reached the same way, through `ThreadService.threadTranscriptPath`; what a run
does with a predecessor's path is specified in `agent-automations.md`.

**A12, end to end.** Every step the account performs — spawn-edge lookup, Turn
reads, payload reads, and the write — sits inside the best-effort guard, not
just the write. That includes subject resolution, which runs **synchronously on
the turn-completion path**: it reads a store, and a throw escaping it would
abandon the rest of the completion tail (the parent-visible activity row, the
idle notification) and park a waiting parent until its own deadline. An account
failure logs, leaves `transcriptPath` null, and never fails the Turn, the
outcome delivery, or the Skill result.

**Header values are single-lined.** The header is the one region of the file
that presents itself as structure rather than content, and some subject values
are user-authored (a Thread's name, an Automation's). Admission trims but does
not strip interior newlines, so the renderer collapses them: otherwise a name
like `report\ncwd: /tmp` writes a second header line no reader could tell from a
real one. Content below the header is exempt by design — verbatim is the point,
and the preamble says a heading inside content is content.

**Lifecycle.** `ThreadCatalogOps.deleteThread`'s descendant cascade removes the
artifact — the walk includes the subtree's root, so a Thread that keeps an
account without being anyone's child is covered by the same rule. Removal marks
the Thread discarded so nothing new enqueues, then drains
the append chain so an append already past its guard and awaiting reads
finishes BEFORE the `rm` — otherwise it lands behind the removal and resurrects a
transcript the user deleted — and it owns the chain entry's removal for the same
reason: a chain cleared during coordination teardown cannot afterwards be
drained. A drain that times out is not a drain that finished: the timeout keeps
the chain handle, and the write side re-checks the discarded mark immediately
before touching the file, so an append that was merely slow rather than wedged
cannot write the transcript back after the `rm` and leave a deleted Thread's
content on disk until the next launch. The guard is scoped to deletion
specifically and NOT to any subtree
stop: archive and stop keep the artifact, and the Turn they interrupt is the
Thread's last one, so skipping it would leave a retained transcript ending
mid-task with no later Turn to heal it. At startup an orphan sweep deletes any transcript
whose Thread id has no Thread record (A11: the work queue is derived from disk,
so an interrupted sweep resumes for free). Accumulation here is an app-retention
concern; git is never involved.

**Operator dump.** `bun run agent:dump <userDataDir> <threadId> [--brief]`
prints the same projection at `full` detail for ANY Thread in ANY state,
including one still running, so forensics is a command instead of a hand-written
parser. It is read-only by construction: the Thread's rollout JSONL is the only
file touched (via the non-repairing `RolloutStore.readSnapshot`, so it never
truncates a torn tail another process owns), and the projection is rebuilt in a
throwaway in-memory database rather than opening the app's SQLite files. A
top-level guard routes every failure — invalid Thread ids and corrupt rollouts
above all, since those are the CLI's primary forensic inputs — through the
usage/exit-2 path instead of an unhandled-rejection stack trace.
**3. Receipt (internalized, never user-facing).** What the delegation
consumed. The token budget is a system fail-safe — a circuit breaker sized at
definitely-anomalous, not an allocation. The test is **not whether a number is
visible but whether anyone is asked to decide on it**: a user states a need and
never reasons in tokens, so no product surface may require a token judgement of
them — delegation rows, failure copy, and the Turn Details reading flow
speak time and status first and money at most, and the budget has no product
settings UI. Token-denominated surfaces are the ones where nobody is deciding:
model-facing tools, warning steering, and typed errors as system internals, and
the Turn Diagnostics Model Interactions inspector as a forensic surface for
whoever is debugging a run. Enforcement lives where
the resource is consumed: the shared descendant pool closes subtree minting,
Turn admission gates new work, the kernel port bounds in-flight work, and fixed
depth/count limits keep delegation legible. The user's explicit Turn remains
outside admission and in-flight gates while its descendant usage still accrues.

Cross-cutting rules: the user bright line (a human-triggered Turn is never
gated) holds across all three layers — as an ADMISSION-LEVEL invariant and
defense-in-depth, not a product journey: child Threads are composer-less and
user control on them is interrupt-only (PM ruling 2026-07-30, recorded in
`docs/plans/archive/agent-subagent-interaction.md`), so the supported recovery paths
for an exhausted child are parent respawn/synthesis and the transcript
artifact (which is why its write must not depend on the child's budget or
liveness), not in-child continuation; exhaustion gates the admission of NEW
work only and never destroys or hides produced artifacts; and the contract
applies uniformly to every executor form — an executor that cannot yield all
three layers is not complete.
