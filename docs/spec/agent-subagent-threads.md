# Agent Subagent Threads

An Agent is delegated work executed in a child Thread. The child keeps ordinary
Thread, Turn, Item, rollout, and extension state; an Agent execution record adds
only orchestration identity and lifecycle metadata. It is not a second history
store, an Agent Team member, or a shared mutable conversation.

Isolated Skills also use child Threads, but remain a separate executor form.
Their invoking `skill` call owns the result, and they do not participate in Agent
messaging, depth, concurrency, or completion notifications.

## Evidence Boundary

This specification is Tenon's current product contract. Claude Code `2.1.227`
black-box captures can support only surfaces retained by provenance-bound
sanitized projections: selected tool catalog fields, fresh-task isolation and
selected context/tool presence, foreground/background ordering and result
shapes, and selected `main` delivery envelopes. The catalog and output-helper
projections are committed under `captured/`; their closed Tenon mappings live
under `normalized/`. `provenance.json` binds capture identity and
`evidence-index.json` limits each claim to its admitted evidence level. Full
provider captures are not committed because they contain repository
instructions, local paths, and git status.

A projection is treated as captured evidence only when the fixture provenance
manifest binds it to the exact CLI version, binary SHA-256, signature identity,
capture date/profile, capture-script SHA-256, full-source SHA-256, and
projection version. A filename or an embedded version string alone is not
provenance. Depth, concurrency, direct-parent synthesis, model stop, renderer
user stop, persistence, worktree, budget, and output scanning below are Tenon-
local contracts informed by product requirements or public documentation; they
are not described as black-box Claude parity without a version-bound capture.

## Lineage And Identity

`parentThreadId` records the canonical delegation edge. Root and descendants
share a `sessionId`; `forkedFromId` records history-fork lineage independently.
Every child has its own catalog record, rollout, Turns, Items, active-Turn lock,
Goal, and extension state. Parent and child never share mutable Turn history.

Each model-created Agent receives one stable opaque Agent ID. That ID maps to the
child Thread, direct parent, spawning tool-use ID, selected Agent definition,
effective configuration, optional worktree, stop provenance, and a monotonically
increasing execution generation. A resume appends a new Turn to the same child
Thread and increments the generation; it does not create another Agent identity.

The execution ledger is also the sole persistence owner for terminal generation
facts. Each terminal notification row identifies the generation, canonical
child Turn, stable delegating parent Item, outcome and stop provenance, bounded
error, direct parent, delivery state, and any parent Turn that consumed the
notification. Renderer projection combines that row with the canonical child
Turn into an immutable generation receipt, adding the recorded duration and
whether useful terminal output exists. Foreground settlement, including an
isolated Skill, has no parent notification, so its delivered row projects as
`notificationState: none` with no delivery Turn; it still produces a receipt.
Tool-result normalization does not derive or rewrite these facts: the receipt
retains the stable spawning `parentItemId`, and an isolated Skill returns its
bounded report as supplemental `skill` result text without entering the Agent
notification lifecycle.
The stable execution row remains current Agent liveness, never historical
generation outcome.

An isolated Skill also persists an execution row, but its Thread source is
`agent.skill` rather than `collaboration`. The row carries the foreground tool
policy needed to execute and recover safely; it does not turn the Skill into an
Agent address or a resumable Agent. `agent_message` and `task_stop` resolve only
collaboration Threads.

Every delegated child, including an isolated Skill, is admitted through one
durable prepare/commit protocol. Before creating a worktree, Thread, budget
member, Goal state, payload, or Turn, the host fixes the child and first Turn
IDs and resolves worktree isolation through a read-only planning step. An
isolated admission produces the complete deterministic recovery intent
`{ sourceCwd, baseCommit, path, branch, gitCommonDir }`; a non-isolated
admission records no worktree intent. The host persists the `pending` execution
row, including that full intent and the effective policy, before any Git
mutation. Only then may worktree preparation create a directory, registration,
or branch. Its complete worktree metadata is persisted on the pending row
before any Thread state is written.

The first durable `turn/started` event in the child's rollout is the cross-store
commit authority; the derived history projection is not. Extension admission
contributions may prepare the Turn before that event, but they must be
idempotent and startup cleanup removes state for a Turn that never becomes
durable. Admission first persists both `thread/started` and the initial
`turn/started` with their ordinary observers deferred. It then advances the
execution marker to `committed`. Only after that marker commits does it publish,
in order:

1. `thread/started` to ordinary listeners (including the renderer) and extension
   `onNotification` observers;
2. `onThreadStarted`;
3. the initial `turn/started` to ordinary listeners and extension
   `onNotification` observers;
4. `onTurnStarted`; and
5. provider execution.

A failure before the durable `turn/started` commit rolls the child back without
publishing any start, stop, or terminal notification or lifecycle observer. A
failure after that event keeps the child and terminalizes or recovers its
canonically accepted Turn; it never reports a failed spawn while deleting that
Turn. `onThreadStarted` is one publication attempt, not a retryable side effect.
If it fails, the already accepted Turn is fatalized, its initial `turn/started`
notification is still published, and neither `onTurnStarted` nor provider
execution runs. Its terminal failure may therefore call `onTurnError` without a
paired `onTurnStarted`. The failed start hook is not replayed later.

The rollout remains authoritative at terminal settlement. If a terminal event
is durably appended but the derived history projection cannot apply or rebuild
it, the host does not append a second terminal event. A lifecycle that already
published its start publishes that committed terminal and idle status once,
releases active ownership, and completes budget, transcript, and parent-delivery
settlement from the canonical Turn in memory. Reference-based payload cleanup is
deferred until startup rebuilds the projection from the rollout.

Startup resolves this protocol before ordinary Thread reconciliation. It reads
the child's rollout directly rather than trusting the derived history
projection. A matching first `turn/started` completes a stale pending marker,
then ordinary resumed lifecycle reconciliation takes ownership of the crashed
in-progress Turn. This crash gap never replays the provider call,
`thread/started`, `turn/started`, `onThreadStarted`, or `onTurnStarted`; recovery
terminalizes the accepted Turn through the host-restart path. A pending intent
without that event first recovers and settles its deterministic worktree, then
removes the incomplete Thread subtree, budgets, Goals, payloads, rollout,
transcript, and other artifacts. The execution ledger row is deleted last; any
earlier cleanup failure preserves it as the durable retry authority for the next
startup. A modified worktree, residual registration or branch, or any cleanup
failure therefore quarantines the admission rather than guessing or discarding
recovery state. Orphan executions follow the same worktree-first, ledger-last
order. Recovery uses an internal artifact cascade: it does not run extension
lifecycle hooks and does not forget a transcript exclusion owned by the
surviving root session.

Each retained quarantine is reported best-effort to the global Diagnostics
subsystem defined by [`error-observability.md`](error-observability.md). The
record uses domain `persistence`, code
`subagent-initial-admission-quarantined`, status `worktree-retained` or
`cleanup-failed`, and the stable `threadId`. An execution-backed admission also
reports its authoritative `turnId`; a reverse orphan has no trustworthy Turn
identity and omits that field. It never includes a worktree path, branch, Thread
content, prompt, or tool output. Diagnostics is inspection-only; the execution
ledger remains the recovery authority even when reporting fails.

A delegated Thread without an execution record is a reverse orphan. Without a
persisted recovery intent, only `child.cwd === parent.cwd` proves that it never
entered an independent worktree. Any distinct cwd is quarantined rather than
deriving recovery state from the checkout's current HEAD. Until recovery
settles, every delegated runtime entry point fails closed before Skills, tools,
extensions, or provider I/O can run.

Terminal-notification and `main`-message delivery use that same availability
gate for both the recipient Thread and the sending Agent. The check runs before
an envelope is claimed, a generation is continued, or a Turn is started or
steered. A quarantined recipient defers its parent-delivery queue; a quarantined
sender skips only that sender's envelope, so healthy sibling envelopes for an
available recipient continue in the same pass. In both cases the skipped
durable envelope remains `pending` for a later startup. No quarantine path can
re-enter extension or provider execution through internal delivery recovery.

Agent IDs are the only model-visible addresses. Display names may derive from a
Role or task description, but are not routable. Historical task paths may remain
in inert persisted Items from older releases; no current tool resolves them.
Notifications and nested results always travel to the direct parent. Sibling and
ancestor routing is never inferred from display labels.

## Agent Types And Configuration

The ordered Agent-type catalog contains these built-ins, followed by configured
project and user Roles:

- `general-purpose`, backed by the hidden built-in `default` Role
- `explore`, backed by the hidden built-in `explorer` Role
- `plan`, backed by the hidden built-in `plan` Role

The backing definitions do not become selectable Agent types merely because
they are built in. A project or user Role may still explicitly use a backing
name such as `default` or `explorer`; it then appears as an ordinary configured
type. The canonical built-in names `general-purpose`, `explore`, and `plan`
remain reserved and win exact catalog identity. There is no built-in `worker`;
a project or user Role named `worker` is an ordinary configured type. In
particular, `subagent_type: "explorer"` selects an explicitly configured
`explorer` Role, while `subagent_type: "explore"` selects the built-in type.

Omitting `subagent_type` selects `general-purpose`. Resolution first prefers an
exact catalog spelling. Otherwise it trims for matching only, compares
case-insensitively, and treats runs of spaces, underscores, and hyphens as the
same separator. One normalized match resolves to its canonical spelling;
multiple matches are an ambiguity error, and no match reports the available
types. Diagnostics and persistence use the canonical result.

### Presentation

Every Agent type carries a **presentation** — a `persona` (the name a reader
sees) and a `color` (an identity-palette name; the generated mark is drawn in
that hue) — resolved into the identity catalog that the renderer reads through
`identities/get`.

**The persona is the agent's own name, not a label the host puts on it.** It is
spoken into the L2 identity block (`agentPersonaPrompt` for the conversation
agent; `You are <persona>, a headless Tenon Subagent Thread…` for a child) and
into the Turn environment's `replyIdentity`. Asked who it is, an agent answers
with the name on its header — the two used to be different strings, and a reader
who asked was told something the screen contradicted. The default is `Aspen`,
anchored to `DEFAULT_AGENT_PRESENTATIONS.main` so one constant drives both.

It is resolved **per Turn** (`resolveAgentPersona`), not recorded in the
configuration a resumed Turn replays: a rename reaches the next Turn, and a
display name never has to be versioned into the configuration codec. It reads
both configuration layers but resolves only the requested identity, rather than
building the whole identity catalog on every Turn. It is not cached: a rename
must reach the next Turn. A Thread records its BACKING Role (`explorer`) while
identity is keyed on the canonical type (`explore`), so the resolver maps one
to the other. A recorded **nickname wins**: an isolated Skill is spawned as
`role: 'default'` with the Skill's name as its nickname, and resolving it by
type would tell it it is `Bruno` when its own name is what it is.

Because this runs on the USER path, it **degrades rather than throws** (A12): a
configuration the loader cannot read leaves the participant named by its
built-in default; a type without a built-in default is named after its own key.
`identities/get` returns the same built-in fallback catalog, so the prompt and
renderer never disagree about a built-in participant during degradation. The
same rule covers the Role catalog, which is also announced per Turn: an
unreadable catalog becomes a stable built-in-only baseline. Normal catalog
journaling therefore retracts any custom Roles announced before the file broke
instead of leaving them selectable in model context. Only typed
configuration-read failures degrade; unrelated resolver defects still
propagate. `identities/get` is scoped to a Thread because that Thread's cwd is
the authority for its project layer. The renderer retains catalogs per loaded
Thread: opening a child reads the child's catalog, and an unresolved child
falls back to its raw type rather than borrowing the selected root's identity.
After every successful Turn admission, the renderer re-reads the submitted
Thread's catalog, so an external configuration break or recovery reaches that
transcript without a thread switch or settings event. A settings change
re-resolves every already-loaded Thread catalog. One stable warning is sent to
the diagnostic log per configuration file's continuous failure episode. Each
user/project layer ends its own episode as soon as that layer reads
successfully, even when the other layer still fails, and the in-memory episode
tracker has a fixed upper bound.

The paths that stay **fail-closed** are the ones where continuing would be
worse. Spawn resolution (`resolveProfile`, `resolveRole`, `resolveAgentType`),
the raw Role and identity catalogs (`buildRoleCatalogSnapshot`,
`resolveIdentityCatalog`), editor reads (`listEditableRoles`,
`resolveEditableProfile`, `listPresentationOverrides`), and writer validation
all reject unreadable configuration. A spawn must not start a Thread on a
configuration nobody could read, since everything it does afterwards is
decided by it. The editor and writer must expose the broken file because that is
where it is actionable; presenting a healthy-looking partial configuration
would hide the problem. The distinction is the whole of A12: a typo in the
user's file is theirs to fix, not a reason to kill the answer they are waiting
for.

The reserved names a Role may not take are `main`, every built-in canonical
type, AND every built-in BACKING name — `resolveRole` prefers a configured entry
over the built-in definition, and every spawn that names no role asks for
`default`, so a user Role called `default` would quietly become the instructions
every untyped Subagent runs.

What still does NOT carry a persona is DISPATCH. The Role catalog's entries and
its `contentHash` exclude presentation, so renaming an Agent does not
re-announce the catalog or change how the model addresses anyone: the model
hands work to `explore`, and `Rena` is who answers.

A Role declares its own under `presentation`. The identities a user cannot
redefine without forking them — the three built-in types and the conversation's
own agent — are re-skinned through a `presentationOverrides` map in either
configuration layer, keyed by Agent type plus the reserved pseudo-key `main`.
Layering matches Profiles and Roles: project replaces user, entry by entry
rather than field by field. `main` is refused as a Role name so the two key
spaces cannot collide, and a `color` outside the palette is refused at the
write boundary; at the read boundary a stale colour degrades to derivation
rather than drawing nothing.

Identity, definition, capabilities, and execution selection are user-editable
from Settings → Agent → Agents, which reads the whole editable view in one
answer — the identity catalog the transcript draws from beside the Roles and
execution rows the user may change — and writes through `agent_write_role`,
`agent_delete_role`, and `agent_write_presentation`. Role and presentation
writes carry execution selection as a sibling payload when the same Save edits
both. Writing
is a boundary and fails closed (A12): each command re-reads one layer, applies
one change, and validates the candidate **in memory** through the loader's own
decoder before anything reaches disk, then writes atomically. Nothing is written
until the result is known to be readable, so there is no window in which
rejected bytes are the live configuration, no rollback that can itself fail, and
a refused edit leaves neither a file nor the directory it would have sat in.
Only the layer being written is validated — a broken file in the OTHER layer is
someone else's to fix and must not make this one uneditable. A layer that
already fails to parse is reported rather than replaced, because a hand-written
configuration belongs to whoever wrote it; that check is the loader's full
decode rather than a shape guess, so `{"roles": ["auditor"]}` — valid JSON the
loader rejects — is refused instead of silently dropped.

A Role write replaces the entry, so two things are explicit. Its represented
tool and Skill ceilings are replaced deliberately, while unrepresented
`plugins` and `mcpServers` fields are merged from the existing Role so a surface
does not destroy what it cannot show. Model and reasoning fields are not Role
fields and the exact decoder rejects them. The write also carries a
create/update intent, so
creating over an existing name is refused instead of silently replacing a
definition, with no confirmation and no undo. A Role may not take `main` or a
built-in canonical type: `agentTypeCandidates` drops a Role colliding with a
built-in while `resolveRole` prefers it, so such a name would resolve two
different ways and never dispatch.

The editor seeds its fields from the overrides as WRITTEN
(`listPresentationOverrides`), never from the resolved catalog. Seeding from
what resolves and saving it back would write today's built-in default in as a
permanent override, silently opting that user out of every later change to it.
Clearing a presentation field REMOVES the override instead of storing it blank,
so the built-in default shows through again and a later change to that default
still reaches the user. Deleting a Role affects future spawns only: a running
child keeps the configuration it resolved at spawn, and past transcripts fall
through the identity chain rather than losing their speaker. Every write
broadcasts the settings-changed notification the settings window already uses,
and the dock re-reads every loaded Thread's catalog on it — so an Agent renamed
in the editor is renamed in each open transcript at once, rather than at the
next conversation switch.

Defaults are Aspen (teal, `main`), Rena (orange, `explore`), Ada (blue,
`plan`), and Bruno (amber, `general-purpose`) — pinned, well-separated hues. An
identity with no persona is named after its type; one with no colour derives a
hue from its type name over the hues the defaults did not take, excluding the
danger-adjacent red — distinct the moment it exists, with nothing drawn by
anyone. Identity attaches to the TYPE, not to an Agent: concurrent children of
one type share a persona and a colour by design, and the task on each one's
report is what tells them apart.

#### Capabilities

A Role's `overrides` narrow what it may use — `constrainChildCapabilities` can
only ever produce a subset of the parent's, never a superset — and the
conversation agent's Configuration Profile is the ceiling they are narrowed
from. Both are edited as checkbox lists of everything the install has, all
checked by default: checked means available, and unchecking is the only gesture.

A narrowing has **three** states and the write protocol carries all three:
absent leaves what is on disk (a draft that never mentioned a field must not
destroy it), `null` REMOVES the narrowing so everything is inherited, and an
array is the exact set — **including an empty array, which is a ban rather than
a shorthand for inherit**, because `constrainChildCapabilities` honours it and
collapsing it would turn a user's "none" into "all".

All-checked is therefore written as `null`, never as today's catalogue: a
written-out full list freezes the set, so a tool or Skill added to Tenon later
would be silently excluded by a list nobody meant as final. The stored `['*']`
Skill wildcard reads back as every Skill for the same reason. Anything already
stored that the catalogue does not know — an MCP or extension tool, a Skill
declared but not installed — is RENDERED as its own row, so a save cannot
silently drop what the editor could not name. The catalogue itself travels with
the editor's view rather than being imported by the renderer, so a settings pane
cannot drift from the runtime's real tool set.

`plugins` and `mcpServers` are narrowable in the file but have no editor field;
a Role write MERGES `overrides`, so they — and anything else hand-written —
survive a save untouched. The Profile write follows the same rule for `model`
and `reasoningEffort`, which the editor also does not show.

The conversation agent's identity and its Profile are **one** command
(`agent_write_profile` carrying an optional presentation), applied inside a
single validated edit: they are two parts of one file, the user pressed Save
once, and as two sequential writes a refused second one left the first on disk.

#### Execution selection

Each configuration layer has a separate `agentExecution` map keyed by canonical
Agent type, never by hidden backing Role. A row may contain one
`modelProvider`/provider-qualified `model` pair and an independent
`reasoningEffort`; project replaces the same user row as a whole entry rather
than merging individual fields. A custom type's row must live beside its Role
in the same layer. Deleting that Role removes its same-layer execution row in
the same atomic write.

Every collaboration Agent editor except `main` offers **Follow parent** plus the
models from currently usable providers. Reasoning choices are filtered to the
selected model's supported levels. A saved model that later becomes unavailable
stays visible and marked unavailable until the user changes it; saving another
field does not erase the row. Definition, presentation, capabilities, and
execution selection commit in one validated file edit.

A fresh `agent` call resolves the row over its direct parent's complete effective
provider/model/reasoning selection and validates the result before UUID minting,
ledger admission, worktree preparation, child Thread creation, or provider I/O.
If the configured selection is unavailable or incompatible, the child starts on
the parent's complete selection and records a bounded `unavailable` fallback.
The launch result tells the delegating model, while the chip/report tells the
user and links to that type's Agent Settings. If the parent selection is also
unusable, the call fails before creating child artifacts. This availability
drift never deletes or rewrites the standing row.

A successful spawn records the selected definition, effective provider/model/
reasoning snapshot, effective tool policy, preloaded Skills, repository/status
inputs, fallback provenance, and isolation metadata. Resume uses that recorded
configuration and history rather than re-reading a changed Role, execution row,
or startup context. The persisted startup snapshot is projected for the current
Turn of every execution generation, including `agent_message` resume,
user-authored resume, and recovery after host restart. Current explicit
capability blocks still apply to the resumed operation. Nested Agents resolve
against the snapshot their direct parent actually runs.

## Model Tool Surface

The complete Subagent orchestration surface is three top-level tools:

| Tool | Required fields | Optional fields | Runtime defaults |
| --- | --- | --- | --- |
| `agent` | `description`, `prompt` | `subagent_type`, `run_in_background`, `execution`, `isolation` | `subagent_type: "general-purpose"`; `run_in_background: true` |
| `agent_message` | `to`, `message` | `summary` | blank or omitted `summary` derives from the first line of `message` |
| `task_stop` | none in schema | `task_id`, deprecated `shell_id` | runtime requires one ID; `task_id` wins |

`task_stop` addresses both background Agents and background shell tasks. There
is no `bash_stop` alias. The former spawn, send, follow-up, wait, list, and
interrupt collaboration tools have no live schema or handler. Generic historical
tool Items may still render an old name as text, but cannot execute it.

The byte-level descriptions, schemas, and argument normalization are specified
in [`agent-tool-design.md`](agent-tool-design.md). The orchestration behavior and
exact result envelopes below are authoritative for execution.

## Fresh Context

Every `agent` call starts a fresh child context. It never copies a suffix or the
whole epoch of the parent's conversation. The first provider request contains:

1. The selected Agent's system prompt and the date, environment, model, and
   adaptive-thinking envelope appropriate to that type.
2. The exact `prompt` as the initial task message.
3. For `general-purpose` and configured Roles, the repository instruction
   hierarchy and the parent's session-start git-status snapshot.
4. When the child's effective tools include `skill`, for `general-purpose` and
   configured Roles, the available Skill catalog plus the complete content of
   eligible inline Skills explicitly preloaded by the selected Role.

`explore` and `plan` receive their specialized prompts and small environment
envelope, but no repository instructions, git-status snapshot, or available
Skill catalog. When `skill` remains effective, eligible inline Skills explicitly
preloaded by their Role may still contribute complete content; preload is not a
catalog entry. Skill admission is one effective-tool gate: when `skill` is absent,
the host does not construct a Skill runtime, publish a catalog, preload Role
Skills, or recognize direct slash or natural-language Skill invocation.

No fresh Agent inherits parent user or assistant messages, reasoning, tool calls
or results, files the parent read, parent-only invoked Skill content, output
style, Memory routing context or data, or an address roster. The `files`, `outliner`,
`skills`, and Agent-guidance stable-prompt modules are selected from the child's
effective tools. The `memory` stable-prompt module and implicit Memory routing
are root-only, even when the Agent can invoke the public Outline CLI.

Fresh startup and resume are deliberately different. A new `agent` call always
uses the matrix above; `agent_message` to a terminal Agent appends to that
Agent's existing history and retains its recorded identity and configuration.

The repository instructions and git-status input are collected once while the
root Thread is created, before that root becomes available for its first Turn.
The snapshot is keyed by the root's `sessionId`, persisted with the Agent
execution ledger database, and reused by every descendant and after host
restart. Concurrent resolution coalesces onto one collection promise. Deleting
a child does not remove the session snapshot; deleting the session root removes
it with the subtree. A collection failure degrades to descendants without the
optional startup block and records the host diagnostic rather than killing root
creation or a user Turn.

## Tool And Capability Policy

The child starts from tools available to the parent, then applies Core scope,
Agent-type policy, foreground/background policy, Role narrowing, and explicit
blocks. Static exposure and argument-dependent execution are separate checks;
an extension or MCP tool that remains provider-visible still cannot execute
outside the current Agent policy.

The durable category rules are:

| Tool category | `general-purpose` / configured Role | `explore` / `plan` |
| --- | --- | --- |
| Root input, Automation, and root-only host controls | Removed | Removed |
| Outline and file reads | Available when inherited | Available when inherited |
| Outline and direct repository mutations | Available when inherited | Removed by specialized policy |
| `bash` | Available when inherited | May remain; only commands classified entirely as repository inspection may execute |
| Extension and MCP tools | Available when inherited | May remain visible; every classified action kind must be read-only to execute |
| Web and `skill` | Available when inherited | Role-policy dependent |
| `agent` | Available only when the persisted policy permits nesting and the requested ceiling admits it | Removed |
| `agent_message`, `task_stop` | Available | Available |

Background mode further intersects the selected pool with the background-safe
catalog. Worktree mode removes live outline mutations in addition to containing
file and shell mutations. `request_user_input` is never exposed to an Agent.

Role tool configuration distinguishes intent:

- omitted tools use the Agent type's default pool;
- `tools: ['*']`, alone or mixed with names, persists as `requestedTools: null`
  and inherits the resolved parent ceiling;
- `tools: []` is an explicit zero-tool Role configuration and refuses before
  provider I/O;
- a mixed valid/unknown list records bounded diagnostics, drops unknown entries,
  and continues with valid entries;
- a non-empty list that resolves entirely to unknown tools is an admission
  defect and refuses before provider I/O.

The Agent-type catalog is admitted only when spawning is actually possible. A
root requires `agent` in its effective configuration. A child additionally
requires its persisted policy to admit `agent`: nesting must remain allowed, the
Agent type must not be the leaf `explore` or `plan` policy, and an explicit
requested-tool ceiling must include `agent`. Configuration text alone cannot
advertise a Role that the current Thread is unable to launch.

An isolated Skill persists a foreground policy before provider execution. It
inherits the parent's Agent kind, effective worktree restriction, and
`allowNesting` decision; its normalized `allowed-tools` becomes the durable
requested-tool ceiling. The same catalog and execution filters then apply, so a
Skill cannot reset a specialized or isolated parent's restrictions.

Tenon otherwise uses Full Access as specified in
[`agent-tool-permissions.md`](agent-tool-permissions.md). Agent messages are
task direction, not a permission or approval channel. They cannot alter the
capability configuration, expand capabilities, replace repository instructions,
approve a plan, answer a pending user question, or turn another Agent's denial
into authority for the recipient.

## Foreground And Background Execution

Background is the default. `run_in_background: false` makes the `agent` call
foreground and blocking.

- A foreground Agent shares the invoking Turn's cancellation lifetime. Its
  scanned final or partial report returns once through the original tool result,
  and it emits no later task notification.
- A background Agent has an independent cancellation controller. Parent Turn
  completion or cancellation does not stop it. The `agent` call returns after
  admission, and the host delivers completion later.
- An API failure after useful text preserves that text as partial output. A
  failure before useful text is failed, never an empty successful result.
- A successful foreground Agent with no text returns the single fallback block
  `Agent finished without text output.`; it never emits an empty text block.

An admitted background call returns one ephemeral text content block with this
exact normalized template:

```text
Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)
agentId: {agentId} (internal ID - do not mention to user. Use agent_message with to: '{agentId}', summary: '<5-10 word recap>' to continue this agent.)
The agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.
Do not duplicate this agent's work — avoid working with the same files or topics it is using.
If the user asks for progress, say the agent is still running; you'll get a completion notification.
```

Every foreground type returns one bounded host-authored settlement envelope in
the original `agent` tool result. Background notifications, explicit-generation
carry-forward, and exhausted-settlement continuations use the same
`SubagentHandoffProjector`. It preserves the complete child answer in the child
Thread and transcript, then fairly allocates the parent envelope across child
generations. Each member records `full`, `excerpted`, or `omitted` coverage plus
omitted byte/token counts; the aggregate coverage is retained in settlement
metadata. The ordinary ceiling is 16,384 estimated tokens and 65,536 UTF-8
bytes. Explicit carry-forward receives the smaller capacity actually available
after canonical input planning and stays pending when even its control frame
cannot fit.

Only citation references whose markers remain in the selected text are linked
into the parent context. When any member is excerpted or omitted, the Host also
captures the flushed child transcript as an exact Markdown resource, links the
same opaque reference into the parent working set, and emits a path-free
`<transcript-fallback>` marker naming that resource. The provider may inspect the
disposable readable observation; it never receives the constant transcript
path, ContentStore path, digest, anchor, or private resource ID in prose.
Fallback capture failure emits an explicitly unavailable marker, leaves truthful
incomplete coverage, and does not fail the parent Turn.

Agent ID needed for later collaboration remains tool-result metadata. Token
usage, duration, tool counts, worktree paths, and transcript paths remain in
runtime diagnostics and child inspection surfaces; they are not routine handoff
text. Background executions of every type use the launch template, expose the
stable ID, and may later be resumed.

Before any Agent report enters a foreground result or background notification,
the host scans it once. Harness-shaped markers and lines that imitate user or
assistant framing are escaped, and instruction-shaped output receives the
host-authored untrusted-output marker. Ordinary output is byte-preserved; the
scanner never summarizes or silently removes findings. This scanner is a Tenon
safety contract tested with a synthetic adversarial corpus, not a Claude output-
transformation oracle.

## Background Delivery

Each terminal background generation produces one persisted notification keyed
by `{agentId, generation}`. Delivery starts one synthetic Turn with an empty
canonical user input and typed additional context sourced from
`subagent:{agentId}`. It never creates a user-role provider document or a
`userMessage` Item.

Host-authored handling rules are `application/instruction`. Agent identity,
tool-use identity, terminal status, summary, and host error are
`application/observation`. The bounded settlement envelope is a separate
`untrusted/observation`, with selected exact resource references attached to the
owning context Item. Provider projection therefore records the entire delivery
as `systemContext` provenance while keeping dynamic Agent output below
application authority. Failure, model-stop, empty-result, and partial-output
paths use the same typed shape with their appropriate status, optional
result/error, and coverage.

The child Turn and transcript append settle before the notification becomes
deliverable. The direct parent's next idle admission boundary materializes it as
canonical context and continues that parent. Delivery is idempotent across a crash;
completed pending events recover on restart. A child that was still running at
host restart follows the typed host-restart failure path and emits a failed
notification rather than replaying side effects.

When nested token exhaustion requires an internal settlement Turn, that Turn
uses the same empty-user-input rule and carries the settlement envelope as
`untrusted/observation` context sourced from
`subagent-settlement:{deliveryBatchId}`. Admission and startup recovery read the
payload through that exact context-evidence source, authority, purpose, and key,
then verify its SHA-256 against the durable delivery batch before committing the
claim. They never recover the digest from synthetic user text.

Terminal notification rows remain per-generation facts after the stable Agent
execution record advances. Presentation receives receipts for every terminal
generation, including pending, delivering, delivered, and foreground/no-
notification settlement. Each receipt retains the stable parent Item identity
and stop provenance recorded for that generation. A historical spawn or resume
anchor resolves through that parent Item even when the child completed in a
continuation Turn; a delivered report carries the generation recorded by its
receipt. Both therefore retain their own outcome, stop ownership, duration,
error, partial-output fact, and delivery state when the same stable Agent is
resumed and starts working again. The current record's terminal and delivery
fields describe only its current generation and cannot overwrite those
historical facts.

Terminal settlement can discover a live descendant after its initial guard,
including while the transcript flush is in flight. That condition is an internal
deferral: the pipeline resolves normally, retains its reservation, schedules no
timer, and consumes no failure-retry budget. A real settlement failure receives
at most four in-process retries after the initial attempt, with bounded
exponential delays. After the fifth failure the in-process reservation remains
blocked and starts no more work; the execution ledger and canonical terminal
Turn remain durable. An explicit resume receives a stable failure, and the next
host startup reconstructs a fresh bounded recovery attempt from that durable
state.

Undelivered completion notifications and Agent-to-`main` message envelopes are
durable queued work. While either kind is pending or delivering, every involved
descendant endpoint is returned in the Thread catalog's `queuedWorkThreadIds`.
The finished-Thread deletion surface therefore cannot remove a child result or
message merely because its current Turn is terminal; the queued marker clears
only after delivery settles.

Notifications travel one edge at a time. A nested result resumes only its direct
parent. A parent with live descendants remains working even if it has already
produced text; after those descendants settle, it synthesizes their results.
Only that synthesized parent result reaches the next ancestor. The model does
not poll or call a wait tool.

Genuine user input already admitted at the root runs first; pending Agent events
retain arrival order. The renderer and API preserve typed notification origin
instead of inferring it from the rendered text.

Non-command user submission and idle notification delivery share host-owned admission. If
the user wins, the notification remains pending. If the notification starts a
Turn first, the user's stable submission is steered into it while it accepts
input or starts a user Turn after its finishing boundary. Renderer cache timing
never turns this ordering choice into `ThreadBusyError` or dropped user input.

If the provider terminally fails after a notification has started its root Turn,
manual `turn/rerun` replays that Turn's canonical host envelope rather than
claiming the delivery again. The replacement receives a new Turn identity but
retains the original `subagent` trigger, stable delivery client ID, structured
input, and context evidence. Any steering accepted after that host envelope is
restored in order with its own evidence, timestamp, and stable client ID. It does
not materialize or consume newly pending Agent activity during replay. The failed
Turn and replacement start commit as one durable `history/rerun` event, so a failed
Rerun admission cannot erase the notification and a successful one cannot turn it
into user-authored input, drop steering, or deliver either input twice.

## Messaging, Resume, And Stop

`agent_message.message` is the complete plain-text direction. `summary` is a UI
preview only: blank or omitted input derives from the first line of
`message.trim()`, and values longer than 200 characters retain 199 characters
plus one ellipsis.

There are two recipient forms:

- A raw Agent ID steers a running Agent at its next tool-round boundary. Sending
  to a completed, failed, interrupted-by-model, or model-stopped Agent starts a
  new background Turn on the same ID, history, model, type, and configuration.
  Running steering returns exactly
  `{"success":true,"message":"Message queued for delivery to {agentId} at its next tool round.","pin":{"id":"{agentId}","name":"{agentId}","ref":"{shortRef}"}}`.
  Resume returns exactly
  `{"success":true,"message":"Agent \"{agentId}\" was stopped ({terminalStatus}); resumed it in the background with your message. You'll be notified when it finishes.","resumedAgentId":"{agentId}","pin":{"id":"{agentId}","name":"{agentId}","ref":"{shortRef}"}}`.
  `shortRef` is opaque, and both `pin.id` and `pin.name` equal the stable Agent
  ID.
- The reserved `main` recipient queues a non-user message for the main
  conversation and returns exactly
  `{"success":true,"message":"Message queued for the main conversation's next turn."}`.
  Background delivery waits for the root's next idle boundary. A foreground
  child directly invoked by root succeeds immediately, then adds typed
  additional context after its Agent result and before root's next provider
  round. A nested foreground child has no adjacent Agent result in root, so its
  message uses durable background context after the sender settles; it
  starts a non-user root Turn when root is idle and survives restart as pending
  delivery.
  The tool description's `main` row says "background subagents only" to preserve
  the captured catalog projection; a version-bound foreground flow projection
  proves that behavior accepts both modes.

A peer message is never concatenated into a host instruction envelope. The
message body is a scanned `untrusted/observation`; sender type and delivery mode
are `application/observation`; the permission-laundering and optional reply rule
is `application/instruction`. All three entries use
`additionalContextSource: subagent:{senderAgentId}` and project with
`systemContext`, never `userInput`, provenance. Foreground addressable Agents
receive the reply-via-`agent_message` guidance; foreground `explore` and `plan`
omit it because their result exposes no Agent ID. The sender type is attribution,
never an address.

A message to `main` cannot satisfy a pending user question, grant authority,
approve a plan, change configuration, or clear user-stop provenance. Capability
laundering is rejected: an Agent blocked from an operation cannot ask `main` or
another Agent to perform it as if the user had authorized it.

Steering acknowledgement does not promise eventual application. If an Agent
finishes before another tool round, the queued message does not automatically
resume it; a later explicit send to the terminal ID takes the resume path.
Missing, malformed, wrong-session, or unexposed foreground targets fail without
creating a Thread or message. The normalized missing-target result is exactly
`{"success":false,"message":"No agent with ID '{to}' is reachable.\nUse the agent ID from a background agent's spawn result."}`; `{to}` preserves
leading and trailing whitespace.

An Agent cannot message or stop itself. A self-message returns
`{"success":false,"message":"An Agent cannot send a message to itself."}`;
a self-stop fails with `An Agent cannot stop itself.` Isolated-Skill Threads are
never collaboration targets even though they have persisted execution policy.

Stop provenance is explicit:

- `task_stop` records model-stop provenance, cancels a running Agent generation,
  returns exactly
  `{"message":"Successfully stopped task: {agentId} ({description})","task_id":"{agentId}","task_type":"local_agent","command":"{description}"}`,
  and still emits one killed notification. The stable ID remains resumable
  through `agent_message`.
- Renderer Stop records user-stop provenance. A model cannot automatically
  resume that Agent. Only deliberate user input submitted from its transcript
  clears the boundary.
- A model-generated message, including a nested message or the `main` route,
  never counts as user-authored resume or approval.

`task_stop` also stops a background shell task owned by the calling Thread. It
may otherwise stop only a reachable collaboration Agent. `task_id` is
authoritative when both it and deprecated `shell_id` are present. Runtime
validation uses the exact errors `Missing required parameter: task_id`,
`No task found with ID: {id}`, and `Task {id} is not running (status: {status})`.
An Agent/shell ID collision is rejected rather than guessed. Shell stop success
and failure both retain the structured local-tool envelope, including error
code, recovery guidance, and metrics, in the canonical tool result.

## Depth And Concurrency

The values and admission behavior in this section are documentation-informed
Tenon scheduling decisions. No version-bound nested, depth-limit, or
concurrency-limit black-box projection currently supports stronger observed-
parity language.

Depth is derived from persisted parent lineage, never display text. The default
maximum is three Agent layers below root. At the maximum depth, `agent` is absent
from the child's tool pool; a stale or raced call still fails locally without
creating an edge. `explore` and `plan` are leaf Agent types regardless of depth.

The default session-wide running limit is 20 and may be configured to another
positive integer. Admission is atomic across foreground, background, and nested
new Agent calls. A terminal generation releases its slot. There is no lifetime
spawn count, matching Claude Code 2.1.227. A cumulative count is a poor resource
proxy; depth and live concurrency are structural controls, while the request
token budget (default `1,500,000`) is the resource backstop. Deletion or a long
session therefore cannot exhaust future work merely by increasing a spawn count.

Resume is intentionally different: an existing Agent occupies a running slot
but bypasses the new-spawn gate and may temporarily take the live count above
the configured cap. User-started execution from the child panel follows the same
rule. Root Turns, scheduled work, and isolated Skills do not share this counter.

## Worktree Isolation

`isolation: "worktree"` creates a host-managed temporary git worktree before
provider I/O and makes it the Agent cwd for file and shell tools. Path and git
containment checks reject mutation redirection into the main checkout. The shell
sandbox treats the shared Git object database as append-only: commits may create
new loose objects, while existing objects plus `objects/pack` and `objects/info`
cannot be modified or removed. A git worktree cannot isolate the user's live
outline, so Bash commands dynamically classified as `outline.edit` or
`outline.delete` are rejected before process launch. Read-only `outline`
commands and import inspection remain available when otherwise permitted.

Planning a managed worktree is read-only. It resolves and persists the source
checkout, exact base commit, deterministic managed path and branch, and shared
Git directory before preparation may mutate Git. Preparation and startup
recovery must validate and use those five persisted values; neither may
recompute the crash-era base from the current checkout. This ordering makes a
crash after any Git mutation recoverable without treating a later HEAD as
historical evidence.

Isolation is inherited down the execution tree. A nested Agent or isolated Skill
keeps the ancestor's outline-mutation restriction even when its own call omits
`isolation`; file and shell write containment uses the authoritative worktree
`path`, not merely the child's current `cwd`. An active worktree row whose path
does not match its Thread cwd records a warning and lookup continues through the
ancestor chain rather than killing the Turn.

An unchanged worktree is removed at terminal settlement. Resume then creates a
new managed worktree from the persisted `sourceCwd` and `baseCommit`, even when
the primary checkout has advanced to a different commit. The removed metadata is
an authoritative tombstone: lookup does not fall through to an ancestor
worktree or to an unrestricted boundary before resume recreates it. A changed
worktree is retained, reported with its path and branch, and reused by the next
generation. A missing, externally altered, or wrongly registered retained
worktree fails that generation. Tenon never falls back to the parent cwd,
because doing so would break the isolation promise.

## Request Budget

`subagentTokenBudget` is a host circuit breaker and defaults to `1,500,000`.
`null` makes a generation unbounded. The setting is not an `agent` parameter and
no model-visible result exposes live remaining or total values. Initial spawn,
explicit resume, and isolated-Skill admission read the current setting once and
freeze it on that execution generation. Siblings and descendants never debit one
another; each `{agentId, generation}` owns its persisted usage, live in-flight
tally, 80% warning latch, and cap.

`SubagentRequestLedger` records cancellation ownership only. Persistent rows live
in `subagent_request_owners` and `subagent_request_children`; ephemeral Threads
mirror them in memory. A request owner is the delegating Turn that may close and
cancel the descendant set it admitted. Ownership does not carry token allowance,
resolve a budget, or bind descendants to a shared resource pool. Admission
creates the request owner and child row atomically; rollback removes the newly
staged ownership without deleting sibling ownership that still covers surviving
children. Startup subtree cleanup removes child rows and newly empty request
owners in one transaction.

The runtime normalizer feeds live usage to the current generation's breaker.
Completion and failure settlement persist usage before exposing an idle admission
window. At the first 80% crossing, the host admits one ordinary steering notice
asking the Agent to preserve a handoff early: concrete progress, verified
evidence, unknown or unchecked work, and the next action. Exhaustion between
model calls interrupts only outstanding model work, preserves partial output,
keeps the Agent explicitly resumable, and emits the interrupted notification
defined above with usage. A terminal answer already produced remains a normal
finished Turn even if its final call overshot the breaker.

Stopping the request-owning user Turn closes that ownership record and interrupts
its owned descendant closure. Stopping one child interrupts only that subtree;
the request remains open for its still-running delegator. Closed requests refuse
new delegated work and never re-admit queued model traffic as user-authored work.

## Canonical Activity And Presentation

Spawning records the canonical `agent` tool Item and a parent-visible
`subAgentActivity` start tied to its tool-use Item. Terminal activity records
the exact child Turn, terminal state, and typed error when present. A terminal
activity may materialize in a later parent Turn and therefore does not claim an
unrelated spawn position. Duration is read only from the child Turn whose ID is
stored on that activity; a later resumed generation can never supply an earlier
row's elapsed time. Legacy activity without a Turn anchor renders no duration.

The child Thread and Agent execution record are live truth. Parent activity
Items are durable presentation evidence, not another scheduler. Renderer
projection combines canonical lineage, Agent ID/generation, child Thread state,
the current generation's Turn state, and pending notification state. It never
depends on a wait Item or a model-maintained roster. Isolated Skills may produce
the same visible child anchor, but their terminal output remains owned only by
`skill`.

The execution record crosses the process seam as a narrow projection: Agent ID,
direct parent, description, Agent type, run mode, generation, current Turn,
stop provenance, terminal status, notification state, and retained worktree
branch and path. It also carries the delivered `{generation, deliveryTurnId}`
rows that presentation needs to keep historical report cards attached to the
parent Turns that consumed them. The tool policy, startup snapshot, and worktree
recovery intent never cross — they describe how the host executes an Agent, not
what the user is looking at, and a field that never crosses cannot be rendered
by accident.
`thread/subagents/list` reads one conversation subtree's COMMITTED records; an
uncommitted admission is absent, because the host publishes no start for one and
may still roll it back. `subagent/execution/changed` announces each write to the
Thread that delegated the work, ordered with that conversation's own
notifications. It is transient by construction: execution state is derived
orchestration state, and an Agent's canonical history is its own Thread, so it
never enters a rollout. The ledger announces from its own write path rather than
from its callers, so a mutation cannot go unannounced because one call site
forgot.

The host issues at most one OS notification per terminal BACKGROUND generation,
only while the window is unfocused, with fixed content-free copy. Running,
steering, and foreground settlement never notify, and the body never carries an
Agent's own words: Agent output is untrusted content, and the notification
centre is not a place a user can judge it. A retained worktree is readable from
the renderer by Agent ID only — main resolves the directory from the execution
record, and a removed worktree resolves to nothing.

Orderly shutdown uses one bounded deadline for active Turn cancellation,
collaboration settlement, and transcript flushing. Work that settles before the
deadline is drained normally. A deadline expiry records a warning and allows
shutdown to continue; persisted execution, notification, message, and canonical
Turn state remains available for startup recovery instead of making application
exit wait without bound.

## Delegation Products

Every delegated executor form owes its parent three products:

1. **Result, pushed and free to the delegator.** Foreground Agent results arrive
   through the `agent` tool result, background results through direct-parent
   task notification, and isolated-Skill results through `skill`. The delegator
   never polls to discover completion.
2. **Account, pulled and reader-pays.** The process behind the result is a
   bounded readable transcript. Reading consumes the reader's context, never
   the child's budget, and remains possible after terminal failure or budget
   exhaustion.
3. **Receipt, internalized.** Usage and circuit-breaker accounting remain host
   and diagnostic facts. User-facing status speaks in task state and preserved
   results, not token allocation decisions.

### Transcript Account

`thread/TranscriptRenderer.ts` is the sole faithful projection of canonical
Turns into readable text. `renderTurn` reads one Turn and its payloads;
`renderTranscript` composes the same bytes as a header followed by those Turn
renders. Brief output contains Turn status, duration, model, usage, canonical
Items, tool exchanges, and explicit evidence/reset/compaction markers. Full
output additionally contains IDs, payload digests, per-call usage, and retained
reasoning for forensics. Canonical Assistant text is written verbatim so an
incomplete delegated handoff can recover the complete child answer from the
transcript. Existing persisted bounds still apply to tool output, reasoning,
errors, and other bounded payload fields and produce explicit truncation markers
rather than silent cuts.

The transcript is `<userData>/thread-transcripts/<threadId>.md`. It is app-owned,
never placed in the workspace, and readable through existing `file_read` and
`file_grep` capabilities. Canonical rollout and payload stores remain truth; the
file is a rebuildable projection. A single preamble states that transcript
content is a record, not instruction.

Startup moves artifacts from the pre-rename `subagent-transcripts` directory
into the current root before orphan sweeping. Moving preserves released userData;
it never deletes an account that cannot be regenerated because its Thread is
already gone. The current-root file wins a collision. A failed move leaves the
old directory non-empty so startup can resume the disk-derived queue.

`ThreadTranscriptWriter` owns per-Thread cursors, serialized append chains,
recovery, deletion, and orphan sweeping. Its injected `resolveSubject` makes one
decision for every Thread kind: excluded sessions and hidden ephemeral roots
produce no artifact; Agent and isolated-Skill children use their spawn metadata;
persistent roots use root metadata. The subject is frozen when a completed Turn
is enqueued so header identity and write eligibility cannot disagree later. A
child whose execution edge is missing is not promoted into a root account, and a
root name is the value frozen when the append-only header was first written.

The writer appends once per completed Turn. Completed Turns are immutable, so a
reader sees a whole-Turn prefix and historical content never needs invalidation.
On restart or file-size disagreement, the writer rebuilds once from completed
canonical Turns with an atomic temporary-file rename, then resumes appending.
Membership deduplicates by Turn ID, not by most-recent position.

`ThreadTranscriptIndex` derives `index.tsv` from artifacts on disk joined to
current Thread records. It contains `threadId`, source, cwd, timestamps, status,
name, and transcript path, newest activity first. One serialized atomic rewrite
coalesces updates, rechecks for work before clearing its chain, and loads Thread
records in one query. Artifacts on disk define membership; excluded sessions are
subtracted even if deletion was interrupted. Rename, archive, deletion, exclusion,
and startup reconciliation derive the next file rather than accumulating patches.
Header and index values collapse embedded newlines so user-authored names cannot
create structural rows.

A persistent root with file tools receives one stable discovery block naming
the index and explaining when to consult prior records. Delegated children do
not receive the installation-wide index. Session-scoped exclusion removes the
root and every descendant artifact, suppresses their index rows, and rebuilds
them from canonical history if the user re-enables records. Deleting a Thread
subtree marks its writers discarded, drains outstanding append chains, removes
the files, and retains a timed-out chain handle so a slow append cannot resurrect
the account after deletion. Archive and Stop keep the account, including the
terminal interrupted Turn. Startup derives orphan cleanup work from disk.

The Thread action menu names this reversible session-scoped exclusion **Hide
from Recall** and **Show in Recall**. Both states provide a hover hint explaining
that other Threads can read prior transcript accounts, that hiding excludes this
session and its descendants, and that the choice is reversible. The label names
the user-visible behavior rather than the internal records directory; alternatives
such as "Hide from Threads" or "Private" incorrectly imply list visibility or
provider privacy.

An Agent result or notification reports the transcript path only after a
deadline-bounded wait on that child's append chain. Failure or timeout leaves
the path unavailable but never withholds the result. Isolated-Skill result
envelopes and standalone Automation account lookup use the same artifact
contract. `bun run agent:dump <userDataDir> <threadId> [--brief]` reads rollout
data through the non-repairing snapshot path and emits the same projection for
any Thread state from a throwaway in-memory database. Invalid IDs and corrupt
rollouts take the bounded usage/exit-2 path rather than an unhandled rejection.

Every account-layer read, subject resolution, payload read, append, and cleanup
is best-effort under A12. Failure logs and may leave the account incomplete, but
cannot change Agent state, suppress foreground/background delivery, or fail an
otherwise completed Turn.
