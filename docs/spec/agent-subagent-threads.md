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

`collaboration.spawn_agent` accepts an optional `max_total_tokens` positive safe
integer. The runtime-wide `subagentTokenBudget` setting defaults to `1,500,000` and
applies when the spawn omits that parameter; `null` disables the default. An explicit
spawn value takes precedence. The same default applies to collaboration and isolated
Skill child Threads through their shared spawn boundary.

The default is a circuit breaker, not a task allocation. Local usage spans roughly
12k-432k total tokens for legitimate child work (94k median), while the observed runaway
was 682k, so a tight cap would not reliably separate useful work from anomalies. The
1.5M threshold is deliberately generous, around three times the heaviest observed
legitimate child. Budget accounting uses `totalTokens`, including cache reads; no
per-Role or per-Skill defaults alter the global setting.

Budget decisions follow this precedence: an explicit user directive in the prompt,
the parent model's per-spawn `max_total_tokens`, future data-driven Role or Skill
defaults, then the global default. The current runtime implements the ladder's explicit
spawn override and global-default endpoints; Role and Skill defaults remain deferred.

For every enabled budget, the host creates the child Goal before its first Turn with
objective `Subagent task: <task_name>` and uses the existing Goal accounting to
accumulate completed-Turn token usage. Isolated Skill Goals use their generated child
task name in the same objective form.

Reaching or exceeding the total changes the Goal to `budgetLimited`. The single Turn
admission boundary then rejects every new non-user trigger with the complete exhaustion
error, including Subagent follow-up, Goal continuation, and host feature work. A
renderer Turn carries `{ kind: 'user' }` and is never budget-gated, so a human can always
resume the child explicitly. The budget currently governs admission between Turns; it
does not interrupt a Turn already in flight, and the completing Turn may overshoot the
configured total.

`list_agents` and the child tree returned by `wait_agent` expose `tokensUsed` and
`tokenBudget`. A child without a Goal reports `0` and `null`, respectively. Goal status
continues to use the canonical Goal projection, including `budgetLimited`.

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
