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
the shared default. When a Thread with no ancestor pool first spawns, that Thread becomes
the pool holder. Every descendant resolves the nearest holder by following
`parentThreadId`, and every descendant Turn contributes `totalTokens` to that one pool.
The holder's own Turns never debit or gate against the pool. The user-triggered Turn
bright line is an admission-level defense-in-depth invariant, not a product journey:
children have no composer, so recovery from exhaustion is parent respawn or synthesis
plus the preserved transcript artifact.

`collaboration.spawn_agent` also accepts optional `max_total_tokens` as a positive safe
integer. It is a per-child cap on that Thread's own contribution inside the shared pool,
not a grant, reservation, nested pool, or refundable allocation. Omitting it creates no
child-local cap. If the runtime default is disabled, an explicit cap remains enforceable
for that child even though no shared pool exists. Collaboration and isolated Skill
children use the same spawn boundary and accounting rules.

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

`SubagentBudgetLedger` stores one pool row per holder and one internal contribution row
per covered descendant before that descendant's first Turn. Persistent rows live in
`subagent_budget_pools` and `subagent_budget_members` beside Goals in `goals.sqlite`;
ephemeral rows mirror them in memory. The old per-child `thread_budgets` format is deleted,
not migrated or read. Deleting a descendant removes only its member row and never refunds
usage. Deleting the holder Thread deletes the complete Thread subtree and its pool plus
all remaining member rows. A separate lifetime spawn counter survives child deletion and
is removed only with its spawner. The ledger has no model-tool surface; child Goals remain
independent and cannot replace, remove, or raise these host-owned limits.

When either the shared pool or the target child's local cap is exhausted, the single
Turn-admission boundary rejects every new non-user trigger with
`SubagentBudgetExhaustedError`. An exhausted pool holder also cannot spawn another child.
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
User-facing recovery happens in the parent through respawn or synthesis and the preserved
transcript artifact. Self-managed Goals never control this gate.

Completion accrues usage inside the per-Thread mutex before the active Turn is removed
or idle status is exposed, so racing admission observes the committed total. Failure
finalization also accrues any execution usage already returned by the executor. A hard
process crash can still lose usage that existed only in the in-flight process.

At a covered descendant non-user Turn's start, `ThreadService` captures the shared pool
snapshot. If the child's local cap has less remaining than the pool, it captures that
tighter snapshot through the same unchanged kernel port. Explicit user Turns receive an
unlimited (`null`) kernel port and no warning callback, preserving the bright-line
override while still accruing their completed usage. The first provider call is always
admitted; an already exhausted fresh non-user Turn belongs to the admission gate. Before
every later provider projection, the executor adds the normalizer's accumulated Turn
`totalTokens` to the captured usage. Reaching the Turn-start remainder settles genuinely
outstanding model work as `interrupted` with the model-facing token-denominated error.
Normal completion accounting then commits the same usage to both the member and pool,
and the admission gate rejects later non-user Turns.

The exhaustion check runs before steering is drained and before a new `turn_start` is
emitted. If the preceding assistant message is terminal, the Turn remains `completed`
and racing steering remains undelivered even when the budget was exhausted; overshoot
still accrues. Only a boundary with outstanding model work can be interrupted, and every
emitted kernel Turn boundary remains paired.

On the first later-call boundary where Turn usage reaches 80% of the captured remainder,
the host admits one steering input through the ordinary canonical steering path:
`[Budget notice] ~80% of the token budget is consumed (<used> of <budget>). Synthesize
your findings and conclude now.` The notice is a real `userMessage` Item, appears in
diagnostics as steering, and reaches the next provider projection. It is emitted at most
once per Turn; no private prompt overlay or synthetic non-canonical message carries it.
The displayed values are the actual controlling pool-or-cap values at the crossing,
never reconstructed threshold values. Delivery failure is advisory: the kernel
logs it and continues without changing Turn status. Diagnostics mark accepted steering
as consumed only after the runtime drains it into a provider context. Pool holders,
uncovered children, and Threads without a local cap provide no execution port for their
own Turns, so their kernel behavior and event cadence are unchanged.

Spawn admission also enforces two fixed legibility limits: `/root/a/b` is the deepest
task path, so a depth-2 Thread cannot spawn; and one Thread may create at most 16 direct
children across its lifetime. The durable count cannot be reset by deleting a child. The
constants live beside the budget ledger. Both checks run inside the Thread tree mutex and
throw distinct typed errors whose messages name the relevant limit.

`list_agents` and the child tree returned by `wait_agent` expose shared-pool state:
`tokenBudget` is the pool total and `tokensUsed` is total pool spend. Every descendant in
the same pool therefore reports the same pair; child-local contribution and cap remain
internal. An uncovered child reports `0` and `null`.

Token quantities are system-internal. Parent-model tools, warning steering, typed errors,
and diagnostics remain token-denominated. Transcript errors, Turn Details, copied error
text, and Automation run errors translate either stable budget failure into localized
resource-limit copy stating that results were preserved; they never render token counts.

## History And Activity

Spawning records a `collabAgentToolCall` in the sender and a
`subAgentActivity` `started` Item in the sender's active Turn. Child terminal
status queues a parent-scoped `completed`, `interrupted`, or `errored` activity
Item. The queue is flushed into the active parent Turn while it waits, before a
new parent Turn reaches the provider, or before an active parent Turn becomes
terminal. If no parent Turn is active, the activity remains pending for the next
one. Child output remains in the child rollout. Parent-visible summaries are
Items, not copied child history.

Waiting is interruptible and uses a pending latch scoped to the sender Thread. It
has no model-controlled polling timeout: while a child is active, it returns only
for sender steering or direct-child terminal activity. If no child is active it
returns immediately. One return drains every terminal activity already queued,
includes each child's final non-commentary result and error, and also includes the
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

Before child admission, main republishes the payload and copies every nested context,
resource, and complete-output dependency into child ownership. Content-addressed
references and payload digests remain stable; only ownership changes. Admission fails
and cleans the staged child if any dependency cannot be copied. The child therefore
remains projectable and its managed images remain previewable after the parent Thread is
deleted.

Inherited payloads are reducer input, not projector-only message bundles. Skill and Role
catalog reduction, active inline Skill recovery, user-view baseline selection, and
file/Node observation recovery recursively consume their effective typed Turns. A child
compaction checkpoints those inherited states with child-owned references; a later
compaction consumes the prior checkpoint, so repeated compaction does not silently drop
the inherited state. Conflicting frozen projections or unavailable nested dependencies
fail closed.

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
`<userData>/subagent-transcripts/<threadId>.md`. Storage is app-owned and never
the workspace — git never sees a transcript, so there is no gitignore to
maintain, no workspace `file_glob`/`file_grep` noise, and no path by which a
secret echoed into a tool output becomes a committed file. The parent still
reads it with the existing `file_read` / `file_grep`: the capability layer
resolves absolute paths, so an app-owned location costs no new tool and no
permission change. The Thread id alone names the file — globally unique and
derivable from the Thread record, so cleanup and tooling can always reconstruct
the path.

The artifact is extended once per **completed** child Turn, at the child's
turn-completion point, and never on the parent's read path. A completed Turn is
immutable in the event-sourced store, which is what makes the append cursor
monotonic and dissolves two whole problem classes: nothing cached can go stale
because history is never re-rendered, and a concurrent reader sees a
whole-Turn prefix rather than a torn file. A Turn still running is simply not in
the file yet; steering and messages remain the live-interaction surface.
Appends are serialized per child so Turns land in completion order.

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
uniformly to every executor form.

**A12, end to end.** Every step the account performs — spawn-edge lookup, Turn
reads, payload reads, and the write — sits inside the best-effort guard, not
just the write. An account failure logs, leaves `transcriptPath` null, and never
fails the Turn, the outcome delivery, or the Skill result.

**Lifecycle.** `ThreadCatalogOps.deleteThread`'s descendant cascade removes the
artifact. Removal marks the Thread discarded so nothing new enqueues, then drains
the child's append chain so an append already past its guard and awaiting reads
finishes BEFORE the `rm` — otherwise it lands behind the removal and resurrects a
transcript the user deleted — and it owns the chain entry's removal for the same
reason: a chain cleared during coordination teardown cannot afterwards be
drained. The guard is scoped to deletion specifically and NOT to any subtree
stop: archive and stop keep the artifact, and the Turn they interrupt is the
child's last one, so skipping it would leave a retained transcript ending
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
definitely-anomalous, not an allocation: humans never see or set token
numbers; user surfaces speak time/status first and money at most; model-facing
surfaces stay token-denominated as system internals. Enforcement lives where
the resource is consumed: the shared descendant pool closes subtree minting,
Turn admission gates new work, the kernel port bounds in-flight work, and fixed
depth/count limits keep delegation legible. The user's explicit Turn remains
outside admission and in-flight gates while its descendant usage still accrues.

Cross-cutting rules: the user bright line (a human-triggered Turn is never
gated) holds across all three layers — as an ADMISSION-LEVEL invariant and
defense-in-depth, not a product journey: child Threads are composer-less and
user control on them is interrupt-only (PM ruling 2026-07-30, recorded in
`docs/plans/agent-subagent-interaction.md`), so the supported recovery paths
for an exhausted child are parent respawn/synthesis and the transcript
artifact (which is why its write must not depend on the child's budget or
liveness), not in-child continuation; exhaustion gates the admission of NEW
work only and never destroys or hides produced artifacts; and the contract
applies uniformly to every executor form — an executor that cannot yield all
three layers is not complete.
