---
status: meta
priority: P1
owner: relixiaobo
created: 2026-06-06
updated: 2026-06-10
---

# Agent Data Model — Persistence & Context Contract

The **authoritative** shape of everything the agent subsystem persists, and how a
single turn's context is assembled from it. This is the data contract that
[[agent-conversation-model]] (the experience), [[agent-program]] F2/F3/F6 (the
foundation seams + protocol-surface adds), and the memory / task / skills plans all
**consume**. They reference this doc; they must not re-describe the shapes — when a
shape changes, it changes **here**, once.

**Part of the [[agent-program]].** The program doc owns sequencing (M0–M3) and the
unified event taxonomy; this doc owns the *types, logs, on-disk layout, and
invariants*. The conversation/DM/Channel UX, the memory write-pipeline tiers
(v1/v2/v3), and skill structure live in their own plans and are out of scope here —
this doc defines only the durable shapes they read and write.

Foundation work (AGENTS.md A7): settle the mechanism before layering features. Every
load-bearing claim below was stress-tested against the real runtime (see the
*Adversarial review* in [[agent-conversation-model]]); the design here is the
post-stress-test version. **Pre-release clean cut:** change the format, wipe
`~/.lin-outliner-*` dev userData, and delete old readers/aliases instead of
shipping migrations or compatibility branches.

M0/M1 status: this file is now a standing data-model contract, not an unstarted
implementation plan. Shipped behavior must also be folded into `docs/spec/` in
the same change, per AGENTS.md A6.

## Goal

- **One authoritative data model** for agent persistence — three storage families,
  one log engine in three instances, a single `Principal` type, and a distillation
  ladder — so consumers cut their protocol surface against one source, not several.
- **The agent part is event logs; it does not touch Loro.** Loro is the document
  substrate the agent reads/writes as environment, not agent state.
- **Clean ownership.** A conversation owns the objective *record*; an agent owns its
  subjective *memory*; a run owns its *execution detail*. They do not absorb each
  other.
- **Runs on pi-agent-core unchanged** — the engine is stateless transcript-replay;
  everything stateful is assembled by Tenon at two seams (read / write).
- **Cache-disciplined context.** A per-turn assembly ordered by volatility with a
  single volatile tail, so Anthropic prefix caching keeps hitting.

## Non-goals

- **The conversation/DM/Channel experience** (find-or-create DM, Channel creation,
  coordinator routing, `@`-addressing UX) — owned by [[agent-conversation-model]].
  This doc defines `ConversationMeta`; the rendering rules are there.
- **The memory write authority** (Settings/Profile UI + runtime-owned Dream/extraction
  writers, plus offline consolidation) — owned by
  [[agent-conversation-model]] §Memory model. This doc
  defines the `MemoryEntry` shape + the runtime-owned append-surface *contract* (§3), not
  the write machinery.
- **Skill structure / authoring** — owned by [[agent-skills-authoring]]. This doc only
  references the skills file tree as a storage family.
- **Milestone sequencing + the full event taxonomy** — owned by [[agent-program]].
- **Back-compat / migration** — none (pre-release; delete old shapes rather than
  preserving them; the event store removes obsolete dev `sessions/` + derived
  `indexes/` on first access).

## Design — the converged data structure

### 0. Scope & the two-family boundary

**Agent data = the event-log family; it does not touch Loro.** The whole system has two
log families, split by one test — *are there concurrent writers that need convergent
merge?*

```
CRDT (Loro)          → the outline document (user typing + agent commands, two writers)   ← NOT agent data; read/written as environment
linear event log     → conversation / run / memory  (one writer per stream)               ← "the agent part"
versioned file tree  → skills (authored content)
```

Everything below is the middle row. Loro appears only because the agent perceives and
mutates the outline through the command surface (`origin:'agent'`); the outline's CRDT
storage is the user's, a separate substrate, never where agent conversation/run/memory
state lives. (`loroDocument.ts` is the sole `LoroDoc`; agent logs are single-writer
jsonl by deliberate contrast.)

### 1. Three ownership axes (the key to the whole model)

| Axis | Owner | Holds | Objective / subjective |
|---|---|---|---|
| **per-conversation** | the Conversation | message stream **+ its own summaries** | **objective record** — what this thread said |
| **per-run** | the Agent that runs it (anchored to a conversation) | execution detail of one reply / task | objective process |
| **per-agent** | the Agent | the memory line | **subjective memory** — what I learned / concluded, across all conversations |

> One line: **a conversation owns the "record," an agent owns the "memory."** The
> memory line follows the agent; conversations and channels have no memory of their own.

### 2. One log engine, three instances

A single append-only engine (segmented jsonl + checkpoint + index, one writer per
stream) backs all three. They differ in exactly four things:

| Instance | id scheme | writer | retention | event vocabulary |
|---|---|---|---|---|
| **conversation** | `conversationId` | participants (serialized) | unbounded → segment + checkpoint + index | communication events |
| **run** | `runId` | that run's runtime | bounded → single file; cold-archived/cleaned once distilled | execution events |
| **memory** | `agentId` | the agent (distillation, serialized) | additive, sub-linear | memory-mutation events |

The heavy machinery (segmentation / checkpoint / index / retention) is a **policy only
the unbounded `conversation` instance turns on**; bounded `run` and slow `memory` run
the bare engine. Only **conversation + memory grow monotonically, and both are
low-volume**; the voluminous execution detail lives in `run` logs that **self-clean** —
so nothing high-volume grows unbounded on the hot path.

### 3. Core types (authoritative)

#### One `Principal` — member = actor = addressee

```ts
type Principal =
  | { type: 'user';  userId: string }
  | { type: 'agent'; agentId: string };
type Actor = Principal
  | { type: 'tool'; toolName: string; toolCallId: string }
  | { type: 'system' };                 // matches AgentActor (agentEventLog.ts:15)
// invariant: a message's actor ∈ members ∪ {system}; addressedTo ⊆ members
```

#### per-conversation — the objective record

```ts
interface ConversationMeta {            // meta.json = a PROJECTION of the stream's membership/rename events (cache, NOT authority)
  id: string;
  members: Principal[];                 // authority = member.added/removed events on the stream; this is the rebuilt current set
  goal?: string;                        // a Channel's goal = its render-time identity
  name?: string;
  createdAt: number;
  // product rules (NOT fields): canonical DM = find-or-create-unique on {user, oneAgent};
  //   adding an agent never mutates members in place → spawns a new Channel
  //   (the session list = the Channel list). DM/Channel rendering lives in conversation-model.
}
// cursors are NOT a conversation field: per-principal read state is high-frequency UI state, kept OUT of the
// objective record (else it churns the event log). Separate per-principal store, last-seen seq:
interface ReadCursors { conversationId: string; byPrincipal: Record<string, number> }   // principalKey → last-seen seq

interface MessageEventBase {            // one line in conversations/<id>/segments/*.jsonl
  v: 1; eventId: string; seq: number; createdAt: number;   // seq = order · createdAt = wall-clock
  conversationId: string;
  actor: Actor;                         // actor ∈ members ∪ {system}
}
// the conversation stream is a DISCRIMINATED UNION on `type` — each variant carries ONLY its own payload:
type MessageEvent =
  | (MessageEventBase & {               // ★ COMMUNICATION: the user message OR the final assistant reply
      type: 'message.created';
      messageId: string; parentMessageId?: string;          // branch tree (DM-only retry)
      role: 'user' | 'assistant';                           // tool calls/results are execution → run log (§3 run), never here
      addressedTo?: Principal[]; runId?: string;             // runId = which run produced this assistant message
      content: AgentPersistedContent[];                      // ARRAY (matches AgentEventMessageRecord, agentEventLog.ts:451)
      forwarded?: { fromConversationId: string; sourceMessageIds: string[]; bundleId: string } })  // combined-forward provenance
  | (MessageEventBase & { type: 'message.edited'; messageId: string; content: AgentPersistedContent[] })
  | (MessageEventBase & { type: 'member.added' | 'member.removed'; member: Principal })   // membership history (the authority for meta.json)
  | (MessageEventBase & { type: 'branch.selected'; selectedLeafMessageId: string })
  | (MessageEventBase & { type: 'compaction.completed'; summaryId: string;                // → the DistillationNode (§3 below)
      source: { fromMessageId: string; throughMessageId: string } });
```

**The conversation log per turn ≈ 2 events:** the `user` message + the **final**
`assistant` reply. The intermediate assistant messages (the ones carrying `tool_call`s),
the `tool_result`s, thinking, and deltas are all *execution* — they live in the run log,
never the conversation log. This is what keeps the conversation log low-volume and
keeps `tool_call ↔ tool_result` pairs off the shared channel record (so a flattened
multi-agent transcript stays a valid pi-agent-core transcript — §8).

> **Note — persisted role vs assembled role.** The *persisted* `MessageEvent.role` is
> only `user | assistant`. pi-agent-core's transcript still has three roles
> (`user / assistant / toolResult`); the `toolResult` (and intermediate tool-calling
> `assistant`) turns are **reconstructed at assembly time** by joining the run log
> (§8), never stored as conversation-log roles.

`kind` is **derived, not stored** (members + `goal` presence + canonical-ness). The
ratified product behaviors survive as **rules, not types** — see
[[agent-conversation-model]] §Conversations and §Adding an agent. The speaking rule:
**a run is produced iff a principal is in `addressedTo`**, bounded by a loop budget; the
coordinator is just the default `addressedTo` when the user `@`s no one.

#### per-run — the objective process (all execution detail)

```ts
interface RunMeta {                     // runs/<id>/meta.json
  id: string;
  agentId: string;                      // who runs → the task panel groups by this
  conversationId: string;               // the ONLY anchor (where it lives & reports) — mandatory
  parentRunId?: string;                 // subagent hierarchy
  kind: 'turn' | 'background' | 'subagent' | 'scheduled';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  trigger:                              // why it started — orthogonal to the anchor, NOT a home
    | { type: 'message'; messageId: string }
    | { type: 'node'; nodeId: string }          // a scheduled command node FIRED it
    | { type: 'parent-run'; parentRunId: string }
    | { type: 'manual' | 'system' };
  usage?: Usage;                        // aggregate token + cost for the whole run (Σ its assistant messages) — §9
  fingerprint: {                        // the version boundary that makes replay "same-version replayable", not timeless (§9)
    appVersion: string;
    promptHash: string;                 // agent persona + per-turn reminder shape
    toolSchemaHash: string;             // tool registry + JSON schemas
    skillBindings: string[];            // bound skill ids + content versions
    modelConfig: string;                // provider / model / effort fingerprint
  };
  retention: 'hot' | 'cold-archived' | 'summarized-only' | 'deleted';   // §10 retention state machine
  createdAt: number;
}

interface RunEventBase {                // one line in runs/<id>/events.jsonl
  v: 1; eventId: string; seq: number; createdAt: number;   // seq = order · createdAt = wall-clock
  runId: string;                        // the anchor — every run event carries it (→ conversationId via RunMeta)
}
// ★ ALL execution detail lives here; a DISCRIMINATED UNION on `type` — each variant carries ONLY its own payload
// (symmetric with MessageEvent above). The M0 interface-first PR ships THIS, not a bare event-name list.
type RunEvent =
  // ── run lifecycle ──
  | (RunEventBase & { type: 'run.started' })
  | (RunEventBase & { type: 'run.completed'; usage?: Usage })                       // run-level Σ → RunMeta.usage (§9)
  | (RunEventBase & { type: 'run.failed'; error: { code: string; message: string } })
  | (RunEventBase & { type: 'run.cancelled'; reason?: string })
  // ── assistant message (incl. intermediate tool-calling turns; deltas stream, completed is the durable one) ──
  | (RunEventBase & { type: 'assistant_message.started'; messageId: string })
  | (RunEventBase & { type: 'assistant_message.delta'; messageId: string; delta: AgentPersistedContent })
  | (RunEventBase & { type: 'assistant_message.completed';
      messageId: string; content: AgentPersistedContent[]; usage: Usage })          // per-message token + cost (§9)
  | (RunEventBase & { type: 'thinking.delta'; messageId: string; delta: string })
  // ── tool call / result (the pair BOTH live here — §8 tool-pair safety) ──
  | (RunEventBase & { type: 'tool_call.started'; toolCallId: string; messageId: string; name: string; input: unknown })
  | (RunEventBase & { type: 'tool_call.completed'; toolCallId: string })
  | (RunEventBase & { type: 'tool_call.failed'; toolCallId: string; error: { code: string; message: string } })
  | (RunEventBase & { type: 'tool_result.created';                                  // ★ tool_result lives ONLY here, never the conversation log
      toolCallId: string; content: AgentPersistedContent[]; isError?: boolean })
  // ── permission (canonical names pinned in agent-program M0 taxonomy; keyed by requestId, reconciles checked/resolved + approval.* dual-track) ──
  //   field set MIRRORS the real ToolPermission*Event (agentEventLog.ts:266/293) — the audit + hardening trail (denied reason / recoverability) MUST survive M0:
  | (RunEventBase & { type: 'tool.permission.checked'; requestId: string; toolCallId: string; toolName: string;
      primaryActionKind?: string; actionKinds: string[];
      outcome: 'allow' | 'ask' | 'blocked';
      source: 'global_rule' | 'action_default' | 'configured_deny' | 'policy_denied' | 'classifier'
            | 'classifier_unavailable' | 'safe_allowlist' | 'user' | 'platform_hard_block' | 'runtime';
      classifierResult?: { outcome: 'allow' | 'block'; reason: string; model?: string; unavailable?: boolean };
      descriptorRef?: AgentPayloadRef })                                            // tool descriptor (name+input) offloaded to payloads/ (§5)
  | (RunEventBase & { type: 'tool.permission.resolved'; requestId: string; toolCallId: string; toolName: string;
      status: 'approved' | 'denied' | 'aborted';
      resolvedBy: 'classifier' | 'safe_allowlist' | 'user_once' | 'allow_rule_update' | 'global_rule'
                | 'configured_deny' | 'policy_denied' | 'classifier_unavailable' | 'platform_hard_block' | 'runtime' | 'system_abort';
      updatedRule?: string;
      deniedReason?: 'configured_deny' | 'policy_denied' | 'classifier_blocked' | 'classifier_unavailable'
                   | 'platform_hard_block' | 'run_aborted' | 'runtime' | 'user_denied' }) // deniedReason + resolvedBy = the recoverability/audit trail
  // ── run-scoped INTERACTION / UI-STATE (consumed by ask-user + gen-ui; persisted here so a paused run / widget restores) ──
  | (RunEventBase & { type: 'user_question.requested';                              // [[agent-ask-user-question-tool]] §7 UserQuestionRunEvent
      requestId: string; toolCallId: string; request: AgentUserQuestionRequestView })
  | (RunEventBase & { type: 'user_question.answered'; requestId: string; result: AskUserQuestionResult })
  | (RunEventBase & { type: 'user_question.cancelled'; requestId: string; reason?: string })
  | (RunEventBase & { type: 'widget_state.updated';                                 // [[agent-generative-ui]] — emitted during a tool call
      toolCallId: string; messageId: string; currentState: unknown });
```

**Where the interaction / widget events live.** `user_question.*` and `widget_state.updated`
are **run-scoped** — they occur *during* a run (a paused-for-input run, or a widget-emitting
tool call), so they persist in the **run log** anchored to `runId` (and transitively to
`conversationId` via the run anchor + the producing `messageId`/`toolCallId`), and **project
to renderer UI state** for restore. They are NOT conversation-log events (not communication)
and NOT a separate store. A blocking `user_question` survives restart because the run log is
durable; the renderer rebuilds the pending interaction / widget from it. (The program M0
taxonomy lists these families; this is the anchor decision they were missing.)

There are **no conversation-less runs** — a scheduled routine fired by an outline
`command` node still anchors to a delivery conversation (the agent's DM, or an
automations channel); the node is the `trigger`, not the home. So
`runs WHERE conversationId = X` is *complete* (no runs hide elsewhere); the per-agent
task panel is `runs WHERE agentId = X`.

#### per-conversation — the objective compression (distillation ladder, lower rungs)

```ts
interface DistillationNode {            // conversations/<id>/summaries/ — LLM-generated, recorded (not replay-reproducible)
  id: string;
  scope: 'segment' | 'conversation';
  conversationId: string;               // ★ per-conversation: the compression of the objective record
  summary: string;
  source:                               // ↓ down-pointer (the addressability invariant) — raw retained, never deleted
    | { fromMessageId: string; throughMessageId: string }   // explicit both-ends range
    | { childSummaryIds: string[] };                        // recursive roll-up (deferred)
  createdAt: number;
}
```

#### per-agent — the subjective self

```ts
interface AgentIdentity {               // agents/<id>/identity.json (current-state doc, overwrite)
  agentId: string;                      // STABLE tuple: `${sourceKind}:${sourceInstanceId}:${name}`
                                        //   sourceInstanceId = workspace/root hash for project agents (else 'user' / 'built-in')
                                        //   → two projects' `researcher` do NOT collide in the global memory pool
  displayName: string;                  // rename policy: changing this keeps agentId — memory follows the identity, not the label
  model: string; effort?: string;
  systemPrompt: string;                 // persona
  skills: string[];                     // bound skill ids → skills file tree
}

interface MemoryEntry {                 // projection of the principal's memory/events.jsonl (memory.entry_added/updated/removed)
  id: string;
  principal: Principal;                 // WHOSE self-model this fact is (pool key + elided subject) — see §4 extension
  fact: string;                         // distilled, additive
  originWorkspace?: string;             // where it was learned — PROVENANCE ONLY, never a retrieval fence (D2 revised)
  sources: Array<{                      // ↓ down-pointer to ground truth (visible guard) — does NOT scope retrieval
    conversationId: string; summaryId?: string; messageRange?: [string, string];
    runId?: string; eventId?: string;   // bind to the producing run/event so it can be invalidated (gemini#5)
  }>;
  status: 'active' | 'invalidated';     // soft-deleted when its source branch is discarded / undone (gemini#5) — excluded from injection
  createdAt: number;
}
// ── Write surface (PM-ratified D1) — NOT file_write/edit ──────────────────────────────────
//   The local file tools are realpath-jailed to workspace.root (agentLocalTools.ts:2207), so they
//   cannot reach userData/agent/ at all, and whole-file rewrite + fileWriteChains still risks lost-update.
//   Instead: a RUNTIME-OWNED memory-append API emits memory.entry_added/updated/removed events → projection.
//   Append-only (no lost-update), schema-checked, serialized, and prompt-free (a runtime primitive, not a
//   sandboxed file op). This also honors self-mod's "don't use generic file write for runtime metadata".
// ── Retrieval (D2, REVISED 2026-06-10) ────────────────────────────────────────────────────
//   A pool is ONE UNDIVIDED self-model — like a person, a principal never partitions its own
//   memory by where it works. The former 'isolated' tier is removed. Two modes remain:
//     'global'           — normal reads and Dream writes (default)
//     'read-only-global' — reads stay global; Dream writes pause (stop learning)
//   `originWorkspace` is always recorded as provenance; nothing ever filters on it.
```

### 4. The distillation ladder & the ownership boundary

```
raw messages (conversation log, leaves)
   └─distill→ segment summary       ┐
                └─roll up→ conversation summary ┘  ← per-conversation: the conversation's objective record, compressed
                          ═══════════════ ownership boundary ═══════════════
                          │ Dream uses summaries/search as locators,
                          │ then reads raw conversation/run evidence
                          ▼
                       MemoryEntry        ← per-agent: the agent's subjective memory, across conversations
```

- **One operation ("summarize a span") reused at three scopes**, each rung feeding the
  next. Today's `compaction.completed` already carries the backbone —
  a `source` down-pointer range (`fromMessageId` → `throughMessageId`) over a
  **retained** raw span (`agentEventLog.ts:822-826,968-978`), non-destructive; the
  change is to recognize it as a *multi-consumer* node.
- **The ownership boundary crosses at evidence, not at summaries.**
  Segment/conversation summaries are the *conversation's* objective compression
  and are intentionally lossy. Dream may use them as a map to find candidate
  spans, but a durable `MemoryEntry` must be extracted from raw conversation
  messages and relevant run events. Conversations/channels hold no memory; a
  "channel summary" becomes durable only when a participating agent's memory
  writer records a `MemoryEntry` with raw `sources` provenance.
- **Lossy in content, lossless in addressability.** Every summary / `MemoryEntry` keeps
  a `source(s)` down-pointer; raw is retained permanently, so any distilled claim can be
  drilled back to ground truth — the contamination guard the LoCoMo ceiling demands.

Consumers **beyond context injection**: navigation (summary spine = thread
table-of-contents); **single-tool recall** — model-visible `recall(query,
include_evidence?, max_chars?)` returns active `MemoryEntry` results and may
nest raw excerpts under each entry only by expanding that entry's `sources`; the
raw/fine layer is an internal conversation/run evidence search service, not a
model-visible `past_chats` tool or second recall tool; **Dream candidate
location** (summaries/search identify spans to inspect, raw messages/run events
supply the evidence); titling; re-entry briefs.

### 5. On-disk layout (target)

```
userData/agent/
  agents/<agentId>/
    identity.json                  # per-agent current state: name / model / persona / bound skill ids
    memory/  events.jsonl          # memory.entry_added/updated/removed (runtime-owned append, D1) → projection = MemoryEntry set
                                   #   retrieval: one undivided pool (D2 revised — no workspace tiers); NOT written via file_write
  conversations/<conversationId>/
    meta.json                      # PROJECTION of membership/rename events: members / goal / name (NOT authority)
    cursors.json                   # per-principal read state (UI state, kept out of the objective stream)
    runs.json                      # PROJECTION: run ids anchored to this conversation
    segments/000001.jsonl …        # message stream (≈1 event/msg), append-only, segmented
    summaries/                     # DistillationNode (per sealed segment + roll-ups)
    checkpoints/  index.json       # tail-load snapshot + seq/time → segment (backward paging)
  runs/<runId>/
    meta.json  events.jsonl  payloads/   # bounded execution log; retention: hot → cold-archived → summarized-only → deleted (§10)
  skills/{built-in,user,project}/  # file tree
  # outline document → Loro store (separate substrate, user-owned)
```

M0 re-keys the old flat `sessions/<id>/` model into `conversations/<id>`
(communication) **+** `runs/<id>` (execution) **+** `agents/<id>/memory`
(the reserved memory line).

### 6. Three kinds of time (don't conflate)

| Time | What | Used for |
|---|---|---|
| `seq` | in-stream ordering authority (per stream; runs/conversations have no global order) | replay order, branch pointers |
| `createdAt` | epoch ms UTC on every event | display, retention, time-range navigation (`index.json`), approximate cross-stream merge |
| in-content `UTC time:` | injected into the **current** user message (`agentRuntime.ts:2846`) | so the model perceives "now" — lives in the volatile tail, never the cached prefix |

### 7. Write path — what one turn produces

You address agent A in conversation C → A's runtime (pi-agent-core, stateless) runs one
loop → the **write seam** `handlePiAgentEvent` (`agentRuntime.ts:2178`) routes the
emitted `PiAgentEvent` stream:

```
your message            → MessageEvent(role:'user')      → C's conversation log
A's FINAL reply         → MessageEvent(role:'assistant',  → C's conversation log
                          runId = R)
all execution detail    → run R's events.jsonl            → run log
  (thinking / intermediate tool-calling assistant turns / tool_result / deltas)
run R itself            → runs/R/meta.json (agentId=A, conversationId=C, trigger={message})
```

→ ≈2 events land in the conversation log per turn (cheap, navigable); all the heavy
detail is in the run log.

### 8. Read path — per-turn assembly (the cache-critical part)

pi-agent-core replays whatever `Message[]` we hand it; the **read seam**
`deriveRuntimePiMessages` (`agentRuntime.ts:2414`) builds it. The load-bearing
invariant:

> **Order context by volatility — most-stable first — with exactly ONE volatile region
> at the end; never mutate anything before it.**

Layers:

```
[1] system + persona     — static
[2] tools                — static
[3] distilled-memory prefix   — append-only (per-agent, travels with A)
[4] history (★ mixed-resolution, PM-ratified):
      old segments → rendered as C's segment summaries (no tool events, cache-cheap)
      recent window → verbatim, JOINING those turns' run logs
                      to splice tool_call/tool_result pairs back into a valid pi-ai transcript
[5] volatile tail        → your new message + query-specific recall + in-content time
```

Three rules this forces:

- **Cache discipline.** The prefix is append-only (Anthropic caching is prefix-based —
  `cache_control` on system / last tool / last user message, `anthropic.js:892-900,933`,
  verified). Distilled memory → prefix `[3]`; query-specific recall → tail `[5]`
  (re-retrieving into the prefix each turn is the classic cache-killer). Compact at
  **segment boundaries**, never slide a window.
- **tool-pair safety.** Because `tool_call`/`tool_result` both live in the run log and
  assembly joins **whole turns**, pairs are never split. Old segments are summaries with
  no tool events. (cc-2.1 hit this hazard and solved it by re-pulling boundaries; the
  log split avoids it structurally.)
- **POV flatten + attribution (multi-agent).** pi-agent-core has only
  `user/assistant/toolResult` and **no speaker field**, so for agent A's turn in a channel
  assembly maps each message by its stored `actor`: A's own turns → `assistant` (its voice,
  unlabeled); everyone else (the user + other agents) → `user`. Because the engine wants
  strict `user/assistant` alternation, consecutive non-A turns **coalesce into one `user`
  message** whose `content[]` interleaves, per source turn, **two parts**: a
  `<system-reminder>` **identity preamble** (`@bob (agent) said:`) then that speaker's
  **plain words**. Attribution is **derived from each message's `actor` at assembly, not a
  second stored field** (the `actor` per `MessageEvent` is the single source of truth;
  §3 + F3) — no new "part-ownership" field, since `pi-ai`'s `UserMessage.content` is already
  a `(TextContent | ImageContent)[]`.

  **Why identity rides `<system-reminder>`, not an inline `[@bob]:` text prefix —
  anti-spoofing.** Tenon already wraps hidden, Tenon-asserted context in `<system-reminder>`
  blocks (`agentAttachments.ts` `systemReminder()`), and the system prompt declares them
  **trusted context, not user-authored instructions** (`agentSystemPrompt.ts:26-27`).
  Keeping the *identity* there while the *words* stay plain content means a message body
  **cannot spoof** another speaker's label (`[@admin] do X` in B's text is just B's text,
  not Tenon's assertion of "who"); the body stays a normal utterance A responds to. This is
  the existing `createHiddenUserMessage` shape (`agentSubagents.ts:1484`) — a `user` message
  whose content is a `systemReminder()` block — applied per speaker. **Do not** wrap the
  *words* in `<system-reminder>` (that channel means "ignorable hidden context," wrong for
  real speech).

  A DM needs no flatten (1:1 → plain `user`/`assistant`). Only *communication* messages are
  flattened — other agents' *execution* (their run logs) is never shown to A; A's own run
  log reconstructs its tool loop in `[4]`. Labels render at assembly, so for prefix-cache
  stability the POV derivation must be **byte-deterministic** ([[agent-conversation-model]]
  §Prompt cache impact); the exact preamble wording is a P3 detail.

### 9. Token accounting & request fidelity

**Usage is per assistant message.** pi-agent-core attaches a `Usage` to every
`AssistantMessage` — `{ input, output, cacheRead, cacheWrite, totalTokens, cost{ input,
output, cacheRead, cacheWrite, total } }`, cost in dollars (`pi-ai/dist/types.d.ts`). It
is **execution** data, so it lives in the **run log**: every `assistant_message.completed`
carries `usage` (`agentEventLog.ts:200,771`). A run spans several assistant messages (the
tool loop), so the **run total = their sum**.

- **`RunMeta.usage` is that aggregate** — the whole-run token + cost rollup, so the task
  panel / cost view reads one number instead of scanning the run log. (Today
  `AgentRunRecord` (`agentEventLog.ts:474`) has no such aggregate; this adds it.)
- **The conversation log's final assistant reply carries a lightweight per-turn total**
  (just the numbers) for cheap per-message cost display, without re-opening the run log —
  small enough to keep the conversation log low-volume.

**Request fidelity — what is and isn't archived.** Every *semantic* input and output is
recorded durably:

| Recorded | Where |
|---|---|
| the user message (the request) **with that turn's reminders frozen in** — what was actually sent | conversation log |
| the assistant reply: full text + thinking + tool calls, plus `providerId / modelId / apiId / stopReason / responseId` | conversation log (final) + run log (intermediate) |
| every tool call + tool result | run log |
| token usage + dollar cost | run log (per message) + `RunMeta.usage` (aggregate) |

What is **not** archived is the raw **wire payload** — the entire assembled `Message[]`
plus the system prompt and the tools' JSON schemas that physically went to the provider —
as a verbatim blob. Instead it is **replayable within a version boundary**: replaying the
append-only log through `deriveRuntimePiMessages` reproduces the request **only if the
assembling inputs are unchanged** — system prompt, tool schemas, skill contents, agent
identity, model settings, and the assembly code all drift across app versions. So every run
records `RunMeta.fingerprint` (`appVersion` + prompt / tool-schema / skill-binding / model
hashes), and the honest claim is **"same-fingerprint ⇒ same request"**, not timeless
determinism. If verbatim capture is ever needed (provider-dispute forensics,
prompt-debugging), it is an **opt-in** debug artifact under `runs/<id>/payloads/`, never
the default (it bloats the hot path and duplicates the log).

### 10. Growth & retention (why it doesn't blow up)

| Thing | Growth | Volume | Disposition |
|---|---|---|---|
| conversation log | monotonic | **low** (≈1 event/msg) | segment + checkpoint + index; old segments cold-archivable |
| memory line | monotonic | **low** (distilled, sub-linear) | additive; visible / editable / forgettable |
| run log | many but bounded | high (heavy) | **state machine** (below): `hot → cold-archived → summarized-only → deleted` |

→ Nothing high-volume grows unbounded on the hot path; `append` is O(1) and never
degrades; opening reads only the checkpoint + segment tail.

**Run-log retention state machine** (reconciles "self-clean" with the request-fidelity
claim in §9 — they are not a contradiction, they are different states):

| State | Holds | Still supports |
|---|---|---|
| `hot` | full events + payloads, in the live window | assembly join · same-fingerprint replay · full audit |
| `cold-archived` | full events, compressed, off the hot path | replay + audit on demand (slower); not in the live window |
| `summarized-only` | the distillation summary only; events dropped | navigation + the conversation summary; **NOT** verbatim replay |
| `deleted` | nothing | nothing |

A run is replayable **only while `hot` or `cold-archived`**; once `summarized-only`, the
verbatim request is gone *by design* (the summary is the durable trace). So §9's "replay
within a version boundary" is scoped to those two states, and a run that has been distilled
can drop its heavy events without violating it.

### 11. Multi-agent specialization (same structure, zero new storage)

- **A Channel = the same conversation primitive** — one shared, `actor`-tagged stream;
  `addressedTo` + "respond iff addressed + loop budget" (coordinator = default
  addressee). Detail in [[agent-conversation-model]] §Channel routing.
- **Each agent's turn = one independent stateless call**, fed a POV-flattened `Message[]`
  with other speakers rendered as `actor`-labeled `user` parts (§8).
- **Each agent's run is a parallel sub-stream**, all anchored to the same conversation;
  N agents in a channel = N independent run logs.
- **Memory stays per-agent** — A carries the same memory line into any channel.

### 12. id / reference graph (all by id; no nesting, no global order)

```
message.runId           ──▶ run                     message → its execution (down)
run.conversationId      ──▶ conversation            run → anchor (mandatory)
run.trigger.nodeId      ──▶ outline command node    provenance: what fired it (NOT an anchor)
run.parentRunId         ──▶ run                      subagent hierarchy
DistillationNode.source ──▶ message range | child summaries   summary → raw (addressable)
MemoryEntry.sources[]   ──▶ conversation / summary / range    fact → ground truth
agent.skills[]          ──▶ skills/ file tree
```

### 13. Invariants (the load-bearing rules)

1. One `Principal` = member = actor = addressee.
2. A conversation is **one primitive with no stored `kind`**; DM/Channel is a rendering
   + two product rules (find-or-create canonical DM; adding an agent spawns a new
   Channel). (Rules in [[agent-conversation-model]].)
3. `session` → `{conversation, run}`: **communication → conversation log; execution
   (incl. `tool_result`) → run log only.** Persisted `MessageEvent.role` is
   `user | assistant`; the three-role pi-ai transcript is reconstructed at assembly.
4. A run anchors to **exactly one conversation**; `trigger` is provenance, not a home.
   No conversation-less runs.
5. A conversation owns the **objective record** (messages + summaries); an agent owns
   its **subjective memory**. The distillation ladder's top rung crosses this boundary.
6. Distillation is **lossy in content, lossless in addressability** — every summary /
   `MemoryEntry` carries a down-pointer; raw is retained.
7. The per-turn assembly is **append-only prefix, ordered by volatility, single volatile
   tail**; mixed-resolution; compaction at segment boundaries.
8. Only conversation + memory grow monotonically and both are low-volume; runs follow a
   retention state machine (`hot → cold-archived → summarized-only → deleted`).
9. All agent state is single-writer jsonl event logs; **it never touches Loro**. Loro is
   the user-owned outline document the agent reads/writes as environment.
10. Speaker attribution is stored **once** as each message's `actor`; the POV-flattened
    `user`-message labels are **derived at assembly**, never persisted as a second copy.
    Identity rides a trusted `<system-reminder>` preamble (anti-spoof); the speaker's words
    stay plain content.
11. Token usage + cost is **execution** data: per assistant message in the run log,
    aggregated on `RunMeta.usage`; the conversation log keeps only a lightweight per-turn
    total on the final reply. Wire payloads are replayable within a version boundary
    (`RunMeta.fingerprint`), not archived verbatim.
12. Memory is written by a **runtime-owned append surface** (event-sourced), never generic
    `file_write` — append-only (no lost-update), schema-checked, prompt-free.
13. Memory is **one undivided pool per principal** — never partitioned by workspace
    (D2 revised 2026-06-10; `read-only-global` remains as a pause-writes mode);
    `originWorkspace` is on every entry as provenance only; a `MemoryEntry` whose source
    branch is discarded/undone is **invalidated**, not silently kept.
14. **The event-log stream is the sole authority; everything else is a rebuildable
    projection.** `meta.json`, the checkpoint/snapshot, `index.json`, the render
    projection, and the in-memory pending-interaction/widget state are all caches derived
    from `(conversation segments ∪ run events ∪ memory events)` — discardable and
    rebuildable from the log. A consumer never treats a projection as truth, and a writer
    never mutates a projection without an event behind it. `cursors` are per-principal UI
    state, outside the objective record entirely (not even a projection of it).
15. **Replay fidelity is gated on `RunMeta.retention`; never promised unconditionally.**
    A run is byte-faithfully replayable (within its `fingerprint` version boundary) **only
    while `hot` or `cold-archived`**; once `summarized-only` or `deleted` the verbatim
    request is gone *by design* and only the distillation summary survives. Any consumer
    claiming "replay" or "full audit" MUST read `retention` first and degrade to the
    summary otherwise — §9's fidelity and §10's self-clean are reconciled by this gate,
    not in tension.
16. **Memory invalidation has one owner and one trigger.** When a conversation branch is
    discarded or a turn is undone, the **runtime memory reconciler** (the D1 append-surface
    owner, never the agent) emits `memory.entry_updated` flipping `status` to `invalidated`
    for every `MemoryEntry` whose `source.runId`/`source.eventId` falls in the orphaned
    range. Invalidation is event-sourced (auditable, reversible), excluded from injection,
    and never a silent in-place delete (cf. invariant 13 / gemini#5).
17. **Compaction is evidence-preserving (memory invariant).** For every run, across any
    sequence of auto/manual compactions, (already-Dreamed content) ∪ (still-pending
    content) covers **100%** of the run's semantic content — no message content is ever
    both un-Dreamed **and** unreachable. Concretely: after a compaction supersedes a
    runtime transcript payload (or re-anchors a conversation's active path at the
    post-compact root), the compaction summary is the surviving carrier of the compacted
    content and MUST reach Dream extraction as evidence; and a fork-prefix exclusion is
    valid only in the coordinates of the payload it was computed against — applied to a
    successor payload it is stale, and the successor is fresh evidence from index 0,
    never a silent skip. Resolution stays payload-pinned: a `sources[]` entry pinned
    before a compaction resolves to its original evidence text or fails loud
    (`SOURCE_NOT_FOUND` / `NOT_ON_ACTIVE_BRANCH`), never silently to different content.
    (Shipped by [[agent-memory-source-binding]], PR #178.)

### M0 reality vs next build

- **Already real after M0:** target-oriented conversation/run/agent storage;
  conversation meta + cursors as projection files; stable built-in agent identity;
  principal actors on message records; run meta with trigger/fingerprint/retention;
  scoped payloads; per-conversation run index; checkpoint replay by target offsets
  + `seq`; domain event bus; active-run state isolation; stateless pi-agent-core +
  the two seams.
- **M0.5 clean cut:** remove remaining agent protocol/index/API names that still say
  `session*`; the event store deletes obsolete `sessions/` + derived `indexes/`
  on first access; do not write a legacy `sessions/<id>` reader, adapter, or
  alias.
- **M1 build:** the memory line (+ `sources`); `addressedTo`; distillation-ladder
  consumers + two-step recall; mixed-resolution assembly over old summaries.
- **PM-ratified (2026-06-05):** canonical DM + user-creatable Channels; split-now +
  mixed-resolution; memory retrieval = global pool, pure relevance.
- **PM-ratified (2026-06-06, after the codex + gemini design review):** memory writes via a
  **runtime-owned append surface** (event-sourced), *not* the privileged `file_write` path —
  reversed because the file tools are realpath-jailed to `workspace.root`
  (`agentLocalTools.ts:2207`, can't reach `userData/agent/`) and whole-file rewrite
  risks lost-update; plus an **opt-in isolation tier** (`isolated` / `read-only-global`)
  over the global default, with `originWorkspace` recorded. (Rationale in
  [[agent-conversation-model]] §Memory model.)
- **PM-ratified (2026-06-07):** because Lin has not shipped, use a clean cut:
  remove the foreground model-visible memory write tool and the model-visible
  `past_chats` tool rather than preserving compatibility aliases. The target
  model-facing retrieval surface is the single read-only `recall` tool.
  `include_evidence` defaults to false; evidence is nested under memory entries,
  never returned as sibling ranked items; raw logs expand only through
  `MemoryEntry.sources`; retrieval excludes `status:'invalidated'` and respects
  `max_chars`. Dream/extraction must use summaries/search only as locators and
  must read raw conversation/run records before writing long-term memory.
- **PM-ratified (2026-06-10, post-review revision):** memory is **one undivided pool
  per principal** — the 2026-06-06 `isolated` tier is removed (it had become
  write-partitioned/read-global, and a principal, like a person, does not partition
  its own memory by where it works); `originWorkspace` stays as provenance only and
  `read-only-global` stays as the pause-writes mode. In the same pass, reflective
  runs became **principal-anchored**: `AgentRunAnchor`'s `{type:'agent'}` variant is
  replaced by `{type:'principal', principal}` (anchor = the pool the run maintains;
  executor stays on `RunMeta.agentId`), each principal's reflective-run index lives
  beside its pool, and the task cache joins run meta with dream completions locally
  per principal.

## Protocol-surface coordination (A4 / A7)

These `src/core/*` additions are the [[agent-program]] **F6 consolidated change list**;
M0 lands/reserves the surface so consumers build on the target names directly:

- `actor` on `AgentEventMessageRecord` (`agentEventLog.ts`).
- `Principal` type + conversation `members` (`meta.json` = projection of membership events);
  `cursors` as a **separate** per-principal store; `RunMeta` (mandatory `conversationId`
  anchor + `trigger` provenance); **no stored `kind`** (`types.ts`).
- `agentId` = stable tuple `${sourceKind}:${sourceInstanceId}:${name}` (project instance =
  workspace/root hash), so global-pool memory doesn't collide across projects.
- `MessageEvent.role` narrowed to `user | assistant`; `tool_result` events move to the
  run-log vocabulary; canonical `tool.permission.*` names pinned in the program M0 taxonomy.
- `MessageEvent.forwarded` (combined-forward provenance; `actor` stays the native speaker).
- `DistillationNode.source` (explicit both-ends range) + `MemoryEntry.sources`
  down-pointer (incl. `runId`/`eventId` for invalidation).
- `MemoryEntry` shape: event-sourced (`memory.entry_added/updated/removed`), `originWorkspace`
  as provenance (D2 revised — no retrieval tiers), `status: active|invalidated` (D1/gemini
  undo-invalidation); written via the runtime memory-append API, **not** `file_write`.
- `RunMeta.usage` aggregate + per-turn total on the final reply; `RunMeta.fingerprint`
  (`appVersion` + prompt/tool-schema/skill/model hashes) + `retention` state.

## Extension — principal-keyed memory (the user is an ordinary principal)

**Status: RATIFIED + SHIPPED (merged as PR #173, 2026-06-10; 3-round review gate passed).**
PM ratified the *direction* (2026-06-09: principal-keyed memory +
per-principal Dream, over the earlier publish/subscribe sketch) and said begin; the contract
below is now built. It is **interface-first** — the `src/core/*` surface (`MemoryEntry.principal`)
landed first, then consumers. It adds **no new storage family and no parallel visibility
system**, reuses the existing `Principal` type + `conversation.members`, and **revises shipped
P1+P2** (PR #172) — pre-launch clean cut, no migration. The detail forks are resolved as noted
below (defer agent↔agent reading; third-person `<principal>`; watermark-serialized user-Dream).

### The gap

Today the global pool is **per-`agentId`** (inv. 13): one pool mixes facts *about the
user* with facts *about the agent itself*, and an agent never reads another's pool. So
"how does agent B know the user?" has no answer, and P1's render must *guess* person
with an `agentId === me` heuristic because one pool holds two subjects.

### The reframe — a memory is a fact *about a Principal*

Key a `MemoryEntry` by **who it is about**, not who owns it:

```ts
interface MemoryEntry {
  id: string;
  principal: Principal;   // WHOSE self-model this fact is — REPLACES `agentId`
  fact: string;           // subject-elided, person-neutral (renders to any reader)
  originWorkspace?: string;
  sources: …;             // provenance (who observed it) stays here — subject ≠ author
  status: 'active' | 'invalidated';
  createdAt: number;
}
```

- A **pool = one Principal's self-model.** `{type:'agent', agentId}` pools an agent's
  working self-model; `{type:'user', userId}` pools the person. The **user is just a
  Principal that owns a pool** — no "user-agent" `AgentIdentity` instance with its
  fields nulled.
- `principal` is the **elided subject** of every fact in the pool, so it is *also*
  exactly what the render reads — subject and pool key are one field.
- This is the only genuinely new idea atop [[agent-memory-model]] P1+P2. `Principal`
  is reused verbatim — no new `AgentActor`/union.

### Writing — per-principal Dream (one writer per pool)

**A principal's Dream reads that principal's own activity, models that principal, and
writes only that principal's pool.** One writer per pool → no cross-pool writes, no
N-writers-to-one-pool contention; dedup stays within a single writer. This maps onto
the conversation/run split (inv. 3):

| Dream | reads (its principal's activity) | models / writes |
|---|---|---|
| **agent-principal Dream** | the agent's **run log** (execution) | the agent's self-model |
| **user-principal Dream** | the **conversations the user is a member of** (communication, both sides) | the user's self-model |

So user preferences — stated ("I want terse reviews") or inferred from the back-and-
forth — are captured by the **user-Dream reading the conversation**; an agent's
working habits ("verify HEAD before a gate run") by the **agent-Dream reading its
runs**. Each Dream is independent, has its own watermark, and is parallelizable. (This
replaces P2's single per-agent Dream that read both layers into one mixed pool — the
clean rule is one writer, one subject, one activity layer each.)

### Reading — visibility = conversation membership (no publish ACL)

Writes are per-principal; **reads are cross-principal, by membership.** A reader R
assembles its briefing from:
- **R's own pool** → `<self>` (second person), and
- **every co-member principal's pool** in the current conversation → `<principal name>`
  (third person).

The **user is always a member** of an agent's conversation, so the user's self-model
is **automatically** shared across all the user's agents — no `publishMemoryTo`, no
precedence table; visibility reuses `conversation.members` (already first-class).
*(Revised 2026-06-10: D2's `isolated` tier was removed — each pool is one undivided
self-model; `originWorkspace` never scopes retrieval.)* (Agent↔agent reading — A reads
co-member B's self-model — is the same membership rule and can ship later; the core
need is *agent → user*.)

### Security — the read-path gate

`recall(include_evidence:true)` expands `sources` to **raw transcript**. A
cross-principal read must never dereference another principal's raw conversations:

- **Cross-principal recall returns the distilled `fact` only**; `sources` evidence
  expansion is permitted **only** for entries whose `principal` == the reader's own
  (the runtime evidence service principal-gates the dereference). inv. 6's down-pointer
  stays; the dereference is principal-gated.
- A foreign-principal fact reaches the reader's prefix every turn → it carries the
  **highest load-time-scan bar** (the [[agent-memory-model]] Hardening layer).
- **Scope: one user.** Cross-*user* sharing (multiple people) is a separate
  trust-domain problem, out of scope for the single-user product.

### Consolidated `src/core/*` surface (interface-first)

- `MemoryEntry.principal: Principal` **replaces** `agentId` (also on
  `AgentMemoryEventBase.principal` and the renderer-facing `AgentMemoryEntryView.principal`);
  the memory event log is keyed **per-principal** via `principalKey(principal)`
  (`user:<userId> | agent:<agentId>`). On disk an **agent-principal pool stays in its existing
  identity directory** (`agents/<agentId>/memory/events.jsonl` — the agent's dir *is* its pool,
  not relocated); the **user pool** lives at `principals/user-<userId>/memory/events.jsonl`.
  **No new event types** — the same `memory.entry_added/updated/removed` surface (D1).
- A reserved **user-principal** pool, created by the runtime; its writer is the
  user-Dream.
- **Per-principal Dream**: the agent-Dream over the run log; a new user-Dream over the
  user's conversation-membership set (reusing the existing watermark machinery).
- Assembly reads the reader's own pool + co-member pools (distilled-only for foreign
  principals); the evidence service principal-gates `sources` expansion.

### Revises shipped P1+P2 (pre-launch, no migration)

- **Render** keys zones on `entry.principal` vs the reader's principal (was
  `agentId === me`) — the `<self>`/`<principal>` split becomes a stored-field read, and
  the person-neutral storage rule becomes *principled* (one pool is read by many readers).
- **Dream** splits into per-principal (agent-Dream → runs/self; new user-Dream →
  conversations/user) instead of one per-agent Dream writing a mixed pool.

### Forks — resolved (decide-and-note, within the ratified direction)

1. **Agent↔agent reading** — **deferred.** The briefing/recall inject the reader's own pool
   and the co-member *user* pool only; co-member *agent* pools are not read yet. The membership
   rule already supports them (same `samePrincipal` check), so it is purely additive later.
2. **`<principal>` provenance render** — **third person.** A foreign principal's pool renders
   as a named third-person zone (`<principal name="The user">` → "The user prefers …"), keeping
   the human as the identity authority; only the reader's own pool is second-person `<self>`.
3. **User-Dream cadence/anchor** — **scheduled + manual, watermark-serialized,
   principal-anchored.** The user-Dream runs on the daily schedule and on manual `/dream` (which
   consolidates the conversation into the user pool — the complete conversation-consolidation;
   agent self-models consolidate on schedule). It is executed by the main agent and is the single
   writer of the user pool; concurrent passes are safe because the store serializes by
   `principalKey` and the per-conversation watermark skips already-consolidated evidence.
   *(Revised post-review, PM-ratified 2026-06-10: the original "run-meta stays agent-anchored"
   compromise conflated executor with subject and forced a cross-pool join. A reflective run is
   now anchored to the principal whose pool it maintains — `AgentRunAnchor` gained a
   `{ type: 'principal', principal }` variant replacing `{ type: 'agent' }` — with the executing
   agent recorded separately on `AgentRunMeta.agentId`. Each principal's reflective-run index
   lives beside its pool, so run history and dream state join locally. In the same review pass
   the `isolated` memory mode was removed: a pool is one undivided self-model and
   `originWorkspace` is provenance metadata only, never a retrieval fence.)*

## Canonical memory vocabulary (PM-ratified 2026-06-10)

The memory subsystem is described, in every doc and plan from here on, in the
standard cognitive-science vocabulary. This is a **framing layer over the
structures above — zero storage change**; code identifiers (`dream`, `recall`,
`fact`) stay, and this table is the canonical mapping:

| Term | Definition here | Implemented as |
|---|---|---|
| **Episodic store** | the immutable autobiographical record ("what happened") | conversation + run ledgers (§2, §3) |
| **Semantic store** | distilled knowledge ("what I know"), per Principal | `MemoryEntry` pools (§3 per-agent, Extension) |
| **Procedural store** | reusable competence ("what I can do") | skills (owned by [[agent-skills-authoring]]; named here for completeness) |
| **Index** | the hippocampal-style pointer layer binding semantic ↔ episodic | `sources[]` + `DistillationNode` summaries (§4) |
| **Consolidation** | offline replay of the episodic store distilling into the semantic store | Dream (one writer per pool, watermark cursors; evidence-preserving under compaction, §13.17) |
| **Retrieval** | working memory (the resident briefing) → cued retrieval (`recall`) → source access (evidence expansion) | §8 assembly + the single `recall` tool |
| **Forgetting** | two-strength model: storage strength (never decays; `invalidate` is explicit) × retrieval strength (decays; governs injection ranking). Never deletion. | **target** — `agent-memory-forgetting` (D1); today only invalidate + churn compaction |
| **Transactive layer** | co-members subscribe to each other's *semantic* stores; raw evidence never crosses principals | membership read (shipped #173 for the user pool) + M3-B (`agent-cross-agent-memory`) |

Standing constraint carried over from the agent-memory-model review: strength,
confidence, and salience are **never stored fields on `MemoryEntry`** — anything
of that kind is a rebuildable projection over events (createdAt, access,
invalidation), keeping the stored shape minimal.

Four delta plans extend this frame (scheduled post-M3-B; D2 is
fast-track-insertable): `agent-memory-forgetting` (D1) ·
`agent-memory-encoding-signal` (D2) · `agent-memory-episodic-index` (D3) ·
`agent-memory-retrieval-upgrade` (D4).

## Open questions

These are data-model-local; the experience/sequencing OQs live in
[[agent-conversation-model]] and [[agent-program]].

- **Cross-agent memory sharing — RESOLVED + SHIPPED (PR #173, 2026-06-10).** The contract —
  `MemoryEntry.principal` (replacing `agentId`, the user being an ordinary principal),
  per-principal Dream (write side), visibility by `conversation.members` (read side), and the
  cross-principal read-path security gate — is the **"Extension — principal-keyed memory"**
  section above. Forks resolved: agent↔agent reading deferred (additive later via the same
  membership rule); third-person `<principal>`; user-Dream scheduled + manual,
  watermark-serialized.

- **Memory internal format — DECIDED** — structured event-sourced store, not markdown
  topic files. Memory is runtime-owned state, not an agent-writable file tree.
- **Per-turn memory injection budget** — whole index vs top-N by recency/salience; bound
  it (cc-2.1 caps MEMORY.md at 200 lines / 25KB). **Design direction ratified 2026-06-10:**
  the Bjork two-strength model (retrieval strength as a rebuildable projection) — see
  `agent-memory-forgetting` (D1); the budget question closes when D1 ships.
- **Recursive summary roll-up** (`DistillationNode.source.childSummaryIds`) — deferred
  until single-level segment summaries prove insufficient.
- **Document context: snapshot+delta vs tail** — the live outline is volatile *and*
  large (the worst cache combination). Keep it in the volatile tail, or cache a snapshot
  prefix + send only the Loro delta? Decide when the memory-prefix lands (same
  volatility-ordering machinery).
- **Run-log retention thresholds** — the state machine is fixed (§10); open is the *trigger
  policy* for each transition (age / count / distilled-yet? / disk pressure), tied to the
  compaction trigger.
- **Memory/recall tool surface — DECIDED for target architecture** — the runtime
  append primitive stays; the foreground model-callable memory write tool is not
  the target writer, and `past_chats` is not a target model-visible tool.
  Settings/Profile UI and Dream/extraction callbacks drive writes; foreground
  model access is the single read-only `recall` tool over active memory entries,
  with optional nested evidence expansion. Open detail: exact Dream
  scheduling/throttle policy and review surface.
