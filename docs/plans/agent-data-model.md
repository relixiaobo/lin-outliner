---
status: draft
priority: P1
owner: relixiaobo
created: 2026-06-06
updated: 2026-06-06
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
post-stress-test version. **Pre-release, no back-compat**
(`storage-format-no-backcompat-prerelease`): change the format, wipe `~/.lin-outliner-*`
dev userData — no migration scripts.

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
- **The memory write pipeline tiers** (v1 inline / v2 extraction subagent / v3 offline
  consolidation) — owned by [[agent-conversation-model]] §Memory model. This doc
  defines `MemoryEntry` and the privileged-path *shape*, not the write machinery.
- **Skill structure / authoring** — owned by [[agent-skills-authoring]]. This doc only
  references the skills file tree as a storage family.
- **Milestone sequencing + the full event taxonomy** — owned by [[agent-program]].
- **Back-compat / migration** — none (pre-release; wipe dev userData).

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
interface ConversationMeta {            // meta.json (current-state doc)
  id: string;
  members: Principal[];                 // no stored `kind`: 1:1 + no goal + canonical → render as DM, else group/Channel
  goal?: string;                        // a Channel's goal = its render-time identity
  name?: string;
  cursors: Record<string, number>;      // principalKey → last-seen seq (per-member read state)
  createdAt: number;
  // product rules (NOT fields): canonical DM = find-or-create-unique on {user, oneAgent};
  //   adding an agent never mutates members in place → spawns a new Channel
  //   (the session list = the Channel list). DM/Channel rendering lives in conversation-model.
}

interface MessageEvent {                // one line in conversations/<id>/segments/*.jsonl
  v: 1; eventId: string; seq: number; createdAt: number;   // seq = order · createdAt = wall-clock
  conversationId: string;
  actor: Actor;
  type: 'message.created' | 'message.edited'
      | 'member.added' | 'member.removed'      // membership history = system events on the same stream
      | 'compaction.completed' | 'branch.selected';
  messageId?: string; parentMessageId?: string;            // branch tree (DM-only retry)
  role?: 'user' | 'assistant';          // ★ COMMUNICATION ONLY: the user message + the final visible reply.
                                         //   Tool calls / tool results are NOT here — they are execution (run log, §3 run).
  addressedTo?: Principal[];            // who should respond; omitted in a 1:1
  runId?: string;                       // ↓ which run produced this assistant message
  content?: AgentPersistedContent;
}
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
  createdAt: number;
}

type RunEventType =                     // runs/<id>/events.jsonl — ★ ALL execution detail lives here
  | 'run.started' | 'run.completed' | 'run.failed' | 'run.cancelled'
  | 'assistant_message.started' | 'assistant_message.delta' | 'assistant_message.completed'  // incl. intermediate tool-calling turns
  | 'thinking.delta'
  | 'tool_call.started' | 'tool_call.completed' | 'tool_call.failed'
  | 'tool_result.created'               // ★ tool_result lives ONLY here, never the conversation log
  | 'tool.permission.requested' | 'tool.permission.resolved';
```

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
  agentId: string;                      // explicit tuple `<source>_<name>`
  displayName: string;
  model: string; effort?: string;
  systemPrompt: string;                 // persona
  skills: string[];                     // bound skill ids → skills file tree
}

interface MemoryEntry {                 // agents/<id>/memory/ — top of the distillation ladder (greenfield)
  id: string;
  agentId: string;                      // ★ per-agent: one global pool across all workspaces (PM-ratified)
  fact: string;                         // distilled, additive
  sources: Array<{ conversationId: string; summaryId?: string; messageRange?: [string, string] }>;
                                        // ↓ down-pointer to ground truth (for the visible guard);
                                        //   ★ does NOT scope retrieval — retrieval is pure relevance (PM-ratified)
  createdAt: number;
}
```

### 4. The distillation ladder & the ownership boundary

```
raw messages (conversation log, leaves)
   └─distill→ segment summary       ┐
                └─roll up→ conversation summary ┘  ← per-conversation: the conversation's objective record, compressed
                          ═══════════════ ownership boundary ═══════════════
                          │ the agent actively distills
                          ▼
                       MemoryEntry        ← per-agent: the agent's subjective memory, across conversations
```

- **One operation ("summarize a span") reused at three scopes**, each rung feeding the
  next. Today's `compaction.completed` already carries the backbone —
  `compactedThroughMessageId` over a **retained** range (`agentEventLog.ts:372-378,937-952`),
  non-destructive; the change is to recognize it as a *multi-consumer* node and make the
  down-pointer explicit (`source`).
- **The top rung crosses ownership.** Segment/conversation summaries are the
  *conversation's* objective compression; the agent then distills **its own**
  `MemoryEntry` from them. Conversations/channels hold no memory; a "channel summary" is
  a participating agent's `MemoryEntry` tagged with `sources` provenance.
- **Lossy in content, lossless in addressability.** Every summary / `MemoryEntry` keeps
  a `source(s)` down-pointer; raw is retained permanently, so any distilled claim can be
  drilled back to ground truth — the contamination guard the LoCoMo ceiling demands.

Consumers **beyond context injection**: navigation (summary spine = thread
table-of-contents); **hierarchical recall** — `recall.overview(query)` → matching
summaries *with addresses*, then `recall.expand(summaryId)` → the raw span (coarse layer
above `past_chats`, which stays the raw/fine layer); **memory feedstock** (segment
summaries are the memory line's input); titling; re-entry briefs.

### 5. On-disk layout (target)

```
userData/agent/
  agents/<agentId>/
    identity.json                  # per-agent current state: name / model / persona / bound skill ids
    memory/  events.jsonl          # per-agent memory-mutation log → projection = current MemoryEntry set (one global pool)
  conversations/<conversationId>/
    meta.json                      # members / cursors / goal / name
    segments/000001.jsonl …        # message stream (≈1 event/msg), append-only, segmented
    summaries/                     # DistillationNode (per sealed segment + roll-ups)
    checkpoints/  index.json       # tail-load snapshot + seq/time → segment (backward paging)
  runs/<runId>/
    meta.json  events.jsonl  payloads/   # bounded execution log + large tool outputs / transcripts
  skills/{built-in,user,project}/  # file tree
  # outline document → Loro store (separate substrate, user-owned)
```

Today's flat `sessions/<id>/` (which conflates messages + execution in one stream) is
re-keyed into `conversations/<id>` (communication) **+** `runs/<id>` (execution) **+**
`agents/<id>/memory` (the new memory line).

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
  message whose `content[]` is one labeled text part per source turn** — the label
  (`[@displayName]: …`) is **derived from each message's `actor` at assembly, not a second
  stored field** (the `actor` per `MessageEvent` is the single source of truth; §3 + F3).
  So no new "part-ownership" field is needed: `pi-ai`'s `UserMessage.content` is already a
  `(TextContent | ImageContent)[]`, and each part is a labeled `TextContent`. A DM needs no
  flatten (1:1 → plain `user`/`assistant`). Only *communication* messages are flattened
  here — other agents' *execution* (their run logs) is never shown to A; A's own run log is
  what reconstructs its tool loop in `[4]`. Injecting synthetic / role-mapped content is
  already production behavior (skill preloads, hidden user messages, subagent-completion
  notices).

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
as a verbatim blob. Instead it is **deterministically reconstructable** by replaying the
append-only log through `deriveRuntimePiMessages`: same log + same assembly ⇒ same request.
So "the exact bytes sent" is *reproducible* rather than stored, while every meaningful
field is recorded. If verbatim capture is ever needed (provider-dispute forensics,
prompt-debugging), it is an **opt-in** debug artifact under `runs/<id>/payloads/`, never
the default (it bloats the hot path and duplicates the log).

### 10. Growth & retention (why it doesn't blow up)

| Thing | Growth | Volume | Disposition |
|---|---|---|---|
| conversation log | monotonic | **low** (≈1 event/msg) | segment + checkpoint + index; old segments cold-archivable |
| memory line | monotonic | **low** (distilled, sub-linear) | additive; visible / editable / forgettable |
| run log | many but bounded | high (heavy) | **self-cleans**: cold-archived / dropped once distilled into (message + memory) |

→ Nothing high-volume grows unbounded on the hot path; `append` is O(1) and never
degrades; opening reads only the checkpoint + segment tail.

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
8. Only conversation + memory grow monotonically and both are low-volume; runs
   self-clean.
9. All agent state is single-writer jsonl event logs; **it never touches Loro**. Loro is
   the user-owned outline document the agent reads/writes as environment.
10. Speaker attribution is stored **once** as each message's `actor`; the POV-flattened
    `user`-message labels are **derived at assembly**, never persisted as a second copy.
11. Token usage + cost is **execution** data: per assistant message in the run log,
    aggregated on `RunMeta.usage`; the conversation log keeps only a lightweight per-turn
    total on the final reply. Raw wire payloads are reconstructable from the log, not
    archived verbatim.

### Real today vs build

- **Already real:** event log + checkpoints; `actor` on every event (hardcoded
  `'pi-mono'`); `compaction.completed` as a recorded summary over a **retained** range;
  `AgentDefinitionRegistry`; stateless pi-agent-core + the two seams; subagent
  own-sessionId.
- **Mechanical re-partition:** `session` → `{conversation, run}`; parameterize
  `agentActor()` off `'pi-mono'`; drop stored `kind`; move `tool_result` into the run log.
- **Greenfield:** the memory line (+ `sources`); `members` / `cursors` / `addressedTo`;
  the segment / index physical layout; the distillation-ladder consumers + the two-step
  recall; mixed-resolution assembly (joining the run log).
- **PM-ratified (2026-06-05):** canonical DM + user-creatable Channels; split-now +
  mixed-resolution; memory = one global pool, pure-relevance retrieval; memory writes via
  the privileged `agent-memory/` path. (Full rationale in [[agent-conversation-model]]
  Open questions.)

## Protocol-surface coordination (A4 / A7)

These `src/core/*` additions are the [[agent-program]] **F6 consolidated change list**;
they land **interface-first** before consumers build on them:

- `actor` on `AgentEventMessageRecord` (`agentEventLog.ts`; backward-compatible).
- `Principal` type + conversation `members` + `cursors`; `RunMeta` (mandatory
  `conversationId` anchor + `trigger` provenance); **no stored `kind`** (`types.ts`).
- `MessageEvent.role` narrowed to `user | assistant`; `tool_result` events move to the
  run-log vocabulary.
- `DistillationNode.source` (explicit both-ends range) + `MemoryEntry.sources`
  down-pointer.
- `RunMeta.usage` aggregate (run-level token + cost rollup; `AgentRunRecord` has none
  today) + a lightweight per-turn usage total on the conversation log's final reply.

## Open questions

These are data-model-local; the experience/sequencing OQs live in
[[agent-conversation-model]] and [[agent-program]].

- **Memory internal format** — markdown topic files + index (simple, agent-writable) vs
  a structured store. Lean markdown.
- **Per-turn memory injection budget** — whole index vs top-N by recency/salience; bound
  it (cc-2.1 caps MEMORY.md at 200 lines / 25KB).
- **Recursive summary roll-up** (`DistillationNode.source.childSummaryIds`) — deferred
  until single-level segment summaries prove insufficient.
- **Document context: snapshot+delta vs tail** — the live outline is volatile *and*
  large (the worst cache combination). Keep it in the volatile tail, or cache a snapshot
  prefix + send only the Loro delta? Decide when the memory-prefix lands (same
  volatility-ordering machinery).
- **Run-log retention policy** — when exactly a run log is cold-archived vs dropped after
  distillation (tie to the compaction trigger).
