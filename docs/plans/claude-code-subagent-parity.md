# Claude Code Subagent Parity

**Shape:** (a) ONE complete feature in one PR. Tool contracts, context
composition, execution semantics, renderer state, tests, and current specs ship
together. The build order below is internal sequencing, not a set of partial
releases.

## Goal

Replace Tenon's model-managed collaboration protocol with the observable
in-session Subagent orchestration contract of Claude Code `2.1.227`.

Parity in this plan has a precise meaning: for the same scenario, the model sees
the same Subagent tool names and fields, a fresh Agent or Fork receives the same
categories of context and tools, and foreground/background execution produces
the same lifecycle transitions, result delivery, stop, resume, depth, and
concurrency behavior. Dynamic values such as IDs, paths, configured agent types,
and provider model names may differ; their shape and semantics may not.

Today Tenon exposes six collaboration tools and defaults `spawn_agent` to
`fork_turns=all`. Ordinary delegation therefore copies the parent context,
increasing cost while leaving the model responsible for polling, choosing a
follow-up primitive, and understanding task-path addressing. Nested Agents can
spawn recursively under a lifetime counter but without a live concurrency gate.
The common path does not achieve the context isolation for which Subagents are
being used.

After this change, ordinary delegation starts fresh, a Fork is an explicit
`Agent` type, background completion is host-delivered, and an Agent can be
steered or resumed through one stable ID. Tenon continues to store execution as
Thread, Turn, Item, spawn-edge, and event-sourced persistence; Claude Code's
private storage is not copied.

### Selected decision and constraints

- **Selected target:** the locally observed Claude Code `2.1.227` profile in
  which `fork` is available, `run_in_background` remains model-visible, and
  background is the ordinary default.
- **Hard constraints:** preserve Tenon's process boundary, event-sourced
  Thread/Turn/Item authority, permission checks, token circuit breaker, and
  current Subagent transcript account.
- **Accepted tradeoff:** available Role and provider model names remain Tenon-
  specific; every orchestration rule around them matches the target profile.
- **Minimum acceptable outcome:** no live Codex-style collaboration tool or
  model-managed wait remains, and every normalized parity fixture passes.

## Non-goals

- Do not reproduce Agent Teams: no teammate names, team membership, broadcast,
  shared task list, team protocol messages, or child-as-team-lead behavior.
- Do not reproduce Claude's staged-rollout and environment-variable matrix.
  Tenon ships the selected target profile as one stable contract.
- Do not reproduce cross-session `ListAgents` / `SendMessage`, Remote Control,
  Workflow agents, scheduled-work orchestration, or Agent SDK transport.
- Do not implement the complete `.claude/agents` authoring system, frontmatter,
  hooks, persistent agent memory, or per-agent MCP bootstrap. Tenon's existing
  user/project Roles remain the configurable agent-definition source.
- Do not copy Claude Code's private transcript directory, daemon, cleanup, or
  output-file implementation. Same-session Agent identity and resume survive a
  Tenon restart through existing persistence, but running work does not continue
  while Tenon is not running.
- Do not make terminal-specific controls such as `/subtask`, `/tasks`, Ctrl+B,
  or the Claude agent panel into renderer requirements. Tenon's Subagent rows and
  transcript panel remain its UI.
- Do not merge isolated Skill execution into the Agent protocol. A Skill with an
  isolated child remains owned by the invoking `skill` call and is outside the
  Agent depth, concurrency, messaging, and notification contract.
- Do not preserve Codex-style `spawn_agent`, `followup_task`, `wait_agent`, task
  paths, `fork_turns`, or lifetime-spawn behavior as live aliases.
- Do not expose Tenon's `reasoning_effort`, token budget, Role name, or tool
  ceiling as extra `Agent` input fields. Existing host-owned budget and
  permission limits remain invisible safety constraints.

## Design

### 1. Evidence and parity fixtures

The normative target is the public Subagents documentation at
`https://code.claude.com/docs/en/sub-agents.md` plus black-box captures from the
local Claude Code CLI `2.1.227`. The public changelog at tag `v2.1.227`
establishes the versioned defaults: background execution from `2.1.198`, a
default concurrency cap of 20 from `2.1.217`, nesting depth 3 from `2.1.219`,
and no lifetime spawn cap from `2.1.224`.

The supplied `cc-2.1` source snapshot is explanatory implementation evidence.
In particular, `AgentTool.call`, `runAgent`, `buildForkedMessages`,
`resumeAgentBackground`, `enqueueAgentNotification`, `SendMessageTool.call`,
and `TaskStopTool.call` show the important implementation split between fresh
and exact-tool Fork paths. That source is older than the target contract: its
fork rollout can infer a Fork by omitting `subagent_type`, whereas `2.1.227`
requires `subagent_type: "fork"`. Documentation and black-box captures win every
such disagreement.

Before changing runtime code, add sanitized parity fixtures for:

| Fixture | Compared surface |
| --- | --- |
| `tool-catalog` | tool names, JSON schemas, required/optional fields, validation, and result text |
| `fresh-general`, `fresh-explore`, `fresh-plan` | first provider request: system blocks, initial messages, model settings, and tools |
| `fork-single`, `fork-parallel-batch` | rendered system bytes, exact tools, full message prefix, synthetic balancing tool results, and directive |
| `foreground`, `background` | blocking, cancellation ownership, launch result, terminal result, and permission prompts |
| `steer`, `resume`, `model-stop`, `user-stop` | Agent ID continuity, message timing, stop provenance, and notification generations |
| `nested`, `depth-limit`, `concurrency-limit` | direct-parent delivery, visible tools, refusal text, and slot accounting |
| `output-scan` | instruction-shaped marker and escaping transformations |

Snapshots normalize only opaque IDs, timestamps, filesystem roots, token counts,
provider model IDs, and the dynamic Role catalog. A mismatch elsewhere is a bug,
not an opportunity to invent a Tenon variant. No proprietary source or personal
transcript content enters the repository.

### 2. Model-visible tools

The active Subagent surface contains exactly three tools:

| Tool | Input contract | Behavior |
| --- | --- | --- |
| `Agent` | `description`, `prompt`, optional `subagent_type`, optional `model`, optional `run_in_background`, optional `isolation: "worktree"` | Create one fresh Agent, or an explicit Fork when `subagent_type` is `fork` |
| `SendMessage` | `to`, `summary`, `message` | Steer a running Agent or resume the same Agent in the background |
| `TaskStop` | `task_id` | Stop a running background Agent while recording that the model initiated the stop |

Their names are top-level provider names, not `collaboration.*`. Schemas,
descriptions, defaults, exact validation failures, launch/result text, and
output shapes are snapshot-tested against `2.1.227`. The background `Agent`
result includes the Agent ID and `output_file`, says that completion will arrive
automatically, and tells the model not to duplicate or poll the work. Foreground
returns the final report directly. Resumable Agents expose a stable ID;
one-shot Explore and Plan results do not.

`SendMessage` implements the plain-text in-session Agent branch: `summary` is
required by validation for a string `message`. Structured team messages,
broadcast, and cross-session recipient forms are the explicit Non-goals above,
not silently accepted no-ops.

Omitting `subagent_type` selects `general-purpose`. The reserved values are
`general-purpose`, `Explore`, `Plan`, and `fork`. Internally,
`general-purpose` resolves through the built-in `default` Role and `Explore`
through `explorer`; add a built-in Plan Role with the observed prompt and tool
policy. User/project Roles are appended to the dynamic type catalog under their
existing names. `fork` is reserved and cannot be shadowed. This adapter keeps
Tenon's Role loader without claiming `.claude/agents` file parity.

The optional `model` retains Claude's precedence and persistence semantics:
per-call override, then Role override, then parent model; the resolved choice is
stored on the child and reused by every `SendMessage` resume. Values resolve
against Tenon's active provider catalog, so provider-specific model names are a
normalized fixture difference. There is no model-visible effort override; fresh
Agents inherit the parent's thinking setting, and Forks inherit the complete
model/thinking request configuration.

Remove `spawn_agent`, `send_message`, `followup_task`, `wait_agent`,
`list_agents`, and `interrupt_agent` from `MODEL_TOOL_CATALOG`, handler
contribution, stable prompt, and current protocol discriminants. Pre-release
dev data is wiped rather than migrated. Generic persisted tool-call rendering
may still display an old name as inert historical text, but no old name remains
executable or receives a compatibility handler.

### 3. Fresh Agent context

A non-Fork Agent is built independently and never calls
`collaborationInheritedContext`. Its first provider request contains only:

1. The selected Agent's own system prompt plus environment details.
2. The exact `prompt` as its initial task message.
3. The repository instruction hierarchy loaded for the parent session.
4. The parent session-start git-status snapshot when available.
5. Full content of Skills preloaded by the selected Tenon Role.
6. A startup sibling roster only when `SendMessage` is available and another
   addressable Agent exists at launch.

Explore and Plan omit repository instructions and git status. All other built-in
and Role-backed Agents include them. No fresh Agent receives parent user or
assistant messages, reasoning, earlier tool calls/results, files the parent has
read, already-invoked Skill content, output style, or parent memory projection.
The sibling roster is a launch-time snapshot rather than a live catalog.

Fresh context composition gets one dedicated builder. Initial spawn records its
resolved system/tool configuration; resume reconstructs that same configuration
without rebuilding or duplicating startup messages. The child persists its
selected Agent definition, model choice, effective permissions, tool policy,
preloaded Skills, and session-start inputs so a later resume cannot silently
become a different Agent after configuration changes.

### 4. Fork context and cache identity

`Agent({ subagent_type: "fork", ... })` is the only history-bearing path. It
captures the already-rendered parent provider request rather than re-resolving
configuration:

- the exact rendered system-prompt bytes;
- the exact ordered provider tool array and schemas;
- model, thinking, and non-interactive request settings;
- the complete normalized parent message history through the assistant message
  containing the Fork call;
- the Fork directive appended as the final child user message.

For several Agent calls emitted in one assistant message, every Fork clones the
whole assistant message and fills every unresolved sibling tool call with the
same deterministic synthetic balancing result before appending its own directive.
This preserves valid provider ordering and a byte-identical cacheable prefix.
Tests compare serialized request prefixes, not merely decoded object equality.

A Fork skips both normal Subagent tool filters and receives the parent's exact
tool array. It may create an ordinary fresh Agent while depth allows, but it may
not create another Fork. Because filtering the inherited array would break
cache identity, an impossible Fork or any Agent call at maximum depth remains
visible inside a Fork and fails locally at call time, matching the target.

`isolation: "worktree"` changes the Fork's cwd after the inherited request
snapshot and appends the observed path-translation/re-read notice; it does not
rewrite the inherited history.

### 5. Tool resolution and permissions

Ordinary Agents inherit the parent's available built-in and MCP tools, then
apply the same two-stage filter as Claude Code:

1. Every Agent removes user-question, main-conversation termination,
   plan-entry, task-output, workflow, scheduling, and MCP-wait controls.
   `ExitPlanMode` survives only for Plan; `Agent` survives only below the depth
   limit.
2. A background Agent keeps every MCP tool but only Tenon's equivalents of
   Read, Grep, Glob, shell, Edit, Write, web read/search, task-list, Skill,
   ToolSearch, worktree, Monitor, TaskStop, SendMessage, and Artifact. Every
   other built-in tool is removed without error unless the final pool is empty.

The Role's allow/deny policy narrows that result. A Fork skips both stages and
Role filtering because exact parent tools are its contract. The implementation
keeps one named classifier for these categories so normal spawn, resume,
provider schema, and tests cannot drift.

Subagents inherit the parent's permission mode unless the selected Role narrows
it. A tool call that needs approval pauses the child and surfaces the existing
approval UI in the root conversation, labeled with the Agent. Approval resumes
that exact child call; Esc denies the call without stopping the Agent. A
`SendMessage` is ordinary task direction and can never grant permission, alter
the permission mode, replace repository instructions, or change Agent
configuration. `AskUserQuestion` is never in an Agent tool pool.

### 6. Foreground and background execution

Background is the default. `run_in_background: false` makes the `Agent` tool
call foreground and blocking.

- A foreground Agent shares the invoking Turn's cancellation lifetime, streams
  permission requests to the root UI, and returns its scanned final or partial
  report in the original tool result. It emits no later task notification.
- A background Agent gets an independent AbortController. Cancelling or ending
  the parent's current Turn does not cancel it. The tool call returns after the
  child is admitted; completion is delivered later by the host.
- An API failure after useful text preserves that text as explicitly partial.
  A failure before any text is a failed Agent, never an empty successful result.

Tenon's Agent execution record maps one stable opaque Agent ID to its child
Thread, parent Agent/root Thread, spawning tool-use ID, selected definition,
worktree, stop provenance, and a monotonically increasing run generation.
Initial execution and each resume are separate Turns on that Thread. The record
is persisted with existing Thread metadata; it is not a second transcript.

### 7. Completion notification and output scanning

Each background generation reaches its direct parent as one user-role
`task-notification` document with the target fields and nesting used by `2.1.227`:
task ID, spawning or resuming tool-use ID, output file, terminal status, summary,
optional result/error, usage, and worktree metadata when present. The output
file is Tenon's existing live Thread transcript artifact. The notification is
application-authored framing around untrusted child output.

Before foreground return or background notification, scan the final report with
the Claude behavior:

- insert a backslash into text that imitates harness output such as a
  `system-reminder` tag or a line beginning `Human:` / `Assistant:`;
- prepend the harness marker line when instruction-shaped tags or permission-
  bypass vocabulary match;
- never remove, summarize, or reword the report.

Record a pending notification event only after the child Turn and transcript
append settle. At the direct parent's next idle admission boundary, materialize
the exact notification as canonical input and continue that same parent Agent
or root Thread. Canonical notification identity is `{agentId, generation}`;
delivery is idempotent across a crash. This persistence is an internal Tenon
mechanism, not a different model-visible envelope.

Notifications travel one edge at a time. A nested Agent's result resumes only
its direct parent. A parent that has returned text while descendants remain live
stays working and cannot notify its own parent; after its children settle, it is
resumed to synthesize them. Only the top-level Agent's final summary reaches the
root. The model never polls or calls a wait tool.

If user input already owns the root admission boundary, it runs first and the
notification remains pending. Multiple completions retain arrival order and use
the target fixture's coalescing; they are never wrapped in a Tenon-specific
batch object. On restart, completed pending notifications are recovered, while
an in-flight child Turn follows the existing typed host-restart failure path and
produces a failed notification rather than silently disappearing or replaying
side effects.

### 8. SendMessage, resume, and stop provenance

`SendMessage` addresses the stable Agent ID. `summary` is presentation-only;
`message` is the complete task direction.

- Running target: append one steering event and expose it at the child's next
  tool/model boundary. A finish-versus-send race resolves exactly once.
- Completed, failed, or model-stopped target: start a new background Turn on the
  same child Thread with full prior Agent history and configuration, reuse the
  Agent ID, increment the generation, and emit another notification when done.
- User-stopped target: refuse automatic resume. A deliberate message submitted
  by the user from the child transcript clears that stop; later `SendMessage`
  resumes are allowed again.
- Missing, deleted, one-shot Explore/Plan, or wrong-session target: return the
  target parity error and create no Thread or message.

`TaskStop` records model provenance before cancelling the target. It produces
its own tool result and suppresses a duplicate killed notification for that
generation, but does not permanently poison the Agent ID. Renderer Stop records
user provenance and therefore establishes the no-auto-resume boundary. Model
messages, including those from nested Agents, never count as user approval or a
user-authored resume.

### 9. Depth and concurrency

Depth is derived from persisted parent lineage, not the display task path. The
default maximum is three Agent layers below root. An ordinary Agent at maximum
depth does not receive `Agent`; a Fork retains its exact inherited tool schema
but any Agent invocation returns the observed depth error. A Fork is also
rejected from inside any Fork regardless of remaining depth.

The depth limit and concurrent limit are host runtime settings with defaults of
3 and 20. Their Tenon setting names are internal configuration, not additional
model tool fields.

The default session-wide running limit is 20 and may be changed to any positive
integer through a Tenon runtime setting. Admission is atomic across foreground,
background, and nested `Agent` calls. At capacity, a new model-issued `Agent`
call fails with the target `Concurrent subagent limit reached` result and the
do-not-retry instruction. Slots are released at terminal settlement; there is
no lifetime spawn counter.

To match Claude Code rather than regularize it, an existing Agent resumed by
`SendMessage` occupies a new slot but bypasses the new-spawn gate and can push
the live count over the configured cap. User-launched execution from the child
panel follows the same rule. Isolated Skills, Workflow/scheduled runs, and root
Turns do not share this counter.

### 10. Worktree isolation

`isolation: "worktree"` creates a managed temporary git worktree before child
execution and sets it as that Agent's cwd for file and shell tools. Reuse the
validated git and containment primitives in `AutomationWorktree`, but give
Agent worktrees their own lifecycle and metadata owner.

The sandbox must reject file and shell paths that redirect mutations into the
main checkout, including git-directory overrides. Resume reuses the same
worktree. An unchanged worktree is removed after terminal settlement; a changed
one is retained and its path/branch appears in the result and notification. A
missing or externally altered worktree degrades according to the parity fixture
without silently executing writes in the parent checkout.

### 11. Tenon integration and spec cleanup

Thread, Turn, Item, spawn-edge, transcript, budget, permission, and renderer
projections remain the internal source of truth. Agent IDs replace task paths at
the model boundary only; UI labels can still use Role-derived nicknames. Running,
needs-input, completed, failed, and stopped presentation derives from canonical
child state and notification generation, never from a `wait_agent` Item.

Fold the shipped design into `agent-core.md`, `agent-subagent-threads.md`,
`agent-model-runtime.md`, `agent-tool-design.md`, `agent-tool-permissions.md`,
`agent-thread-rendering.md`, `agent-skills.md`, and `agent-integration.md`.
Repair two active-plan premises in the same PR:

- `agent-tool-call-path` keeps its latest-Turn status-read optimization for
  Agent presentation but removes `wait_agent` as a consumer.
- `agent-streaming-followups` keys eligible-child membership from canonical
  Agent lineage/status rather than an in-progress `wait_agent` Item.

Main owns the matching board cleanup at merge. No dev change to
`docs/TASKS.md` or `CHANGELOG.md` belongs in this PR.

## Requirements

| Requirement | Observable outcome | Acceptance |
| --- | --- | --- |
| **FR-1 Tool contract** | The model uses only the selected `Agent`, `SendMessage`, and `TaskStop` Subagent branches. | AC-1 |
| **FR-2 Context contract** | Fresh Agents isolate parent history; Forks preserve the exact parent request prefix. | AC-2, AC-3 |
| **FR-3 Capability contract** | Agent type, run mode, depth, and Fork status resolve the target tool pool before provider I/O. | AC-4, AC-10 |
| **FR-4 Execution contract** | Foreground blocks; background detaches and completes through host delivery. | AC-5, AC-7 |
| **FR-5 Authority contract** | User approval and user stop remain distinguishable from Agent messages and model stop. | AC-6, AC-9 |
| **FR-6 Handoff safety** | Every final report is scanned and framed exactly once before parent consumption. | AC-7, AC-8 |
| **FR-7 Scheduling contract** | Direct-parent nesting, depth 3, live cap 20, resume bypass, and no lifetime cap match the target. | AC-10, AC-11 |
| **FR-8 Isolation contract** | Worktree Agents cannot mutate the main checkout and retain recoverable changed work. | AC-12 |
| **FR-9 Persistence contract** | Agent identity, configuration, stop provenance, and pending terminal delivery survive restart. | AC-9, AC-13 |
| **FR-10 Boundary contract** | Isolated Skills and scheduled work remain separate consumers of internal child primitives. | AC-14 |

## Runtime Flows and Recovery States

- **FLOW-1 Fresh background:** `Agent` admission -> independent child Turn ->
  immediate launch result -> scanned direct-parent notification -> parent
  continuation. Failure before output is terminal; partial output is preserved.
- **FLOW-2 Foreground:** `Agent` admission -> blocking child Turn -> root-labeled
  permission interaction when needed -> one scanned tool result. Parent
  cancellation cancels the child and no later notification appears.
- **FLOW-3 Nested:** child `Agent` admission -> descendant notification to its
  direct parent -> parent synthesis -> top-level notification to root. Capacity,
  depth, or empty-tool refusal creates no child edge.
- **FLOW-4 Continue or stop:** running `SendMessage` steers once; terminal or
  model-stopped `SendMessage` resumes the same ID; user-stopped refuses until a
  user transcript message clears the stop. Missing transcript, missing
  worktree, restart, and send/finish races settle through the explicit failure
  rules above rather than fallback execution in the parent.

## Acceptance Criteria

- **AC-1 Tool surface:** a provider request exposes only `Agent`, `SendMessage`,
  and `TaskStop` for Subagent orchestration, and normalized schema/result
  snapshots match Claude Code `2.1.227`. No retired collaboration name appears.
- **AC-2 Fresh context:** `general-purpose`, Explore, and Plan first-request
  fixtures match the startup matrix; no parent history, read-file residue, or
  invoked-Skill content leaks into a fresh Agent.
- **AC-3 Fork identity:** single and parallel-batch Fork requests preserve the
  exact parent system/tool/message prefix and prompt-cache identity; a Fork
  remains valid after the source Thread is deleted because dependencies are
  child-owned.
- **AC-4 Tool policy:** foreground, background, Plan, depth-limited, Role-
  narrowed, MCP, and Fork tool pools match the two-stage filter fixtures; an
  empty resolved pool fails before provider I/O.
- **AC-5 Execution modes:** background returns before completion and survives
  parent Turn cancellation; foreground blocks, shares cancellation, returns the
  scanned outcome once, and never emits a later notification.
- **AC-6 Permissions:** child approval prompts identify the Agent in the root
  UI; allow/deny resumes the exact call, while Agent messages cannot approve or
  alter configuration.
- **AC-7 Notification:** success, API failure with/without partial text, model
  stop, worktree, and empty-final-report fixtures produce the exact normalized
  task-notification fields once per generation, including after a crash at each
  persistence boundary.
- **AC-8 Output scan:** every documented instruction-shaped fixture gets the
  same escaping and marker as `2.1.227`; ordinary output is byte-unchanged.
- **AC-9 Messaging:** running steering and finish/send races deliver exactly
  once; completion and model-stop resume under the same ID/history/model, while
  user-stop refuses until explicit user resume.
- **AC-10 Nesting:** fresh Agents can reach depth 3; ordinary depth-limit Agents
  lack `Agent`, Forks retain it but fail locally, and Fork-of-Fork always fails.
  Only the top-level synthesized result reaches root.
- **AC-11 Concurrency:** 20 new Agents run, the next spawn receives the target
  refusal, a terminal Agent releases capacity, resume occupies a slot while
  bypassing the gate, and no lifetime count can block later work.
- **AC-12 Isolation:** worktree file/shell writes cannot escape into the main
  checkout; cleanup, retained changes, notification metadata, nested cwd, and
  same-ID resume match the fixtures.
- **AC-13 Persistence:** same-session completed Agent resume works after Tenon
  restart; running host-restart failure and pending notification recovery lose
  neither a terminal result nor a stop-provenance decision.
- **AC-14 Separation:** isolated Skills keep their existing result owner and do
  not enter Agent limits/notifications; scheduled routines keep their existing
  host entry point while using the revised internal child primitives safely.

## Implementation Surface

| Layer | Primary files and symbols |
| --- | --- |
| Protocol and tools | `src/core/agent/tools.ts` model-tool contracts; `src/core/agent/protocol.ts` Agent task/item/status DTOs; `src/core/agent/configuration.ts` Role adapter; codec tests |
| Context/runtime | `stablePrompt.ts`, context composition, `PiTurnExecutor` provider-request snapshot, and `ToolRuntime` exact handlers/tool filtering |
| Orchestration | `SubagentCollaboration` spawn/fork/message/stop/resume paths; `TurnLifecycle` admission, steering, permission pause, terminal settlement, and continuation; `ThreadService` facade/recovery |
| Persistence/safety | `ThreadMetadataStore`, `SubagentRequestLedger` with lifetime counting removed, a persisted Agent notification record, output scanner, and Agent worktree lifecycle built on `AutomationWorktree` primitives |
| Renderer | Subagent presentation/detail components, user-stop provenance, explicit user resume, permission attribution, process summary, and typed i18n |
| Tests | `agentThreadService.test.ts`, `agentCodexTools.test.ts`, `agentContextComposer.test.ts`, `agentPiTurnExecutor.test.ts`, permission/transcript/codec tests, `subagentPresentation.test.ts`, renderer store/item tests, and `agent-thread.spec.ts` |
| Documents | the eight current specs and two active plans named above |

This plan touches shared protocol files and therefore requires main to serialize
its implementation claim before build. It remains one complete feature rather
than an interface-only PR: exposing the new tool schema without working context,
delivery, and handlers would be an unusable protocol and violate the repository's
complete-feature rule.

## Risks

- **False parity:** prose can hide subtle differences in schemas, provider
  ordering, or stop/resume behavior. Versioned black-box fixtures are the gate.
- **Fork cache regression:** re-rendering either system blocks or tools defeats
  the main economic benefit. Preserve the already-rendered request snapshot and
  compare serialized prefixes.
- **Notification injection:** child output is untrusted. The exact scanner runs
  before host-authored notification framing, and permission checks remain the
  authority for any downstream tool call.
- **Wrong-authority approval:** steering must not resolve a permission prompt.
  Approval identity remains user/UI-owned and binds to one child tool call.
- **Resume misrouting:** Agent ID, session ownership, one-shot status, name
  reuse, and user-stop provenance are checked before appending any message.
- **Intentional cap overflow:** resume bypass is surprising but target behavior.
  Tests distinguish new-spawn refusal from resume accounting so a later cleanup
  does not accidentally change parity.
- **Worktree escape or loss:** reuse containment validation, bind every mutation
  tool to effective cwd, and never fall back to the parent checkout for writes.
- **Adjacent plan drift:** removing wait sentinels invalidates performance-plan
  cache keys. Repair those premises with the protocol change, not afterward.

## Collision Result

Checked `gh pr list`, `docs/TASKS.md`, active plans, and intended file scopes on
2026-08-11:

- PR #530 (`typing-hot-path-memory`) owns Memory/document hot-path work and has
  no Subagent protocol overlap.
- PR #529 (`semantic-working-state`) is merged on main as a plan-only claim.
  This plan follows its Working / needs-input / terminal vocabulary and does not
  add a public `waiting` status. Its future Thread-visual implementation may
  touch the same Subagent components, so main should sequence that implementation
  after this protocol change or rebase it onto the resulting canonical states.
- `agent-tool-call-path` and `agent-streaming-followups` contain the two stale
  `wait_agent` assumptions listed above; this implementation owns those narrow
  documentation repairs.
- No open PR claims `SubagentCollaboration`, `TurnLifecycle`, collaboration
  tool protocol, Agent worktree execution, or Subagent renderer behavior.

## Verification

- Run the parity fixture suite against normalized Claude Code `2.1.227`
  captures and Tenon provider-request/tool outputs.
- Run `bun run typecheck`, `bun run test:core`, `bun run test:renderer`,
  `bun run test:e2e`, `bun run docs:check`, and `git diff --check`.
- Run focused crash-point tests for terminal recording, transcript append,
  notification persistence/admission, stop provenance, and resume.
- Run a production-provider smoke for fresh background fan-out, foreground
  return, Fork cache prefix, nested depth-3 synthesis, concurrent-limit refusal,
  steer-at-finish, model/user stop, same-ID resume, permission prompt, output
  scan, and worktree isolation.
- Record before/after provider-context token evidence proving that ordinary
  Agent spawn carries no parent epoch while Fork keeps the cacheable prefix.

## Open Questions

None. Main review should treat any behavior outside the explicit Non-goals as a
parity defect, not as a local design choice.

## Build Order

- [ ] Freeze sanitized `2.1.227` parity fixtures; replace the model-visible tool
  and Role adapter contract and remove live legacy handlers/prompts.
- [ ] Build fresh context and exact-request Fork paths, including parallel-call
  synthetic balancing results, tool filtering, model/thinking persistence, and
  depth rules.
- [ ] Replace mailbox/wait orchestration with Agent-ID execution records,
  foreground/background ownership, direct-parent notifications, output scanning,
  `SendMessage`, `TaskStop`, resume, and the 20-slot admission gate.
- [ ] Add child permission attribution and worktree isolation, then update
  renderer projections, current specs, affected active plans, automated suites,
  and production-provider evidence.
