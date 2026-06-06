---
status: in-progress
priority: P1
owner: relixiaobo
created: 2026-06-05
updated: 2026-06-06
---

# Agent Conversation Model — Agents, Conversations, Memory

How the agent talks to the user and to the document over time. This plan
replaces the **session-centric** model (one event log per `sessionId`, one
implicit process-global agent) with an **IM-native** model: durable,
memory-bearing **Agents** converse inside **DMs and Channels** over an
**ambient outline**, and "session" dissolves into invisible per-turn context
assembly.

**Part of the [[agent-program]].** The shared L0 foundation (agent identity, `actor`,
session→conversation, the typed event bus + taxonomy, the `AgentSessionState` split) is
**sequenced as M0** in the program doc — this plan keeps the detailed, code-grounded
design of the seams it analyzed, and owns the conversation / memory / task / multi-agent
substance on top. Skills moved to [[agent-skills-authoring]].

Foundation work (AGENTS.md A7): settle the mechanism before layering features.
**This revision is code-grounded** — every load-bearing claim was stress-tested
against the real runtime (see *Adversarial review*), and several were wrong. The
design below is the post-stress-test version.

## Goal

- **Agents are first-class, durable identities** carrying their own memory. An
  agent is the same identity across every conversation it is in.
- **Conversations are one primitive (members + optional goal), not a stored kind.**
  "DM" (1:1, identity = the relationship) vs "Channel" (a goal, 1..N members, identity =
  the goal) is a **rendering** derived from the member set + `goal` presence (§Data
  structure) — not a `kind` enum.
- **Memory belongs to the agent**, lives in runtime storage (not the document,
  not the read-only agent config), and is **visible/editable** (inspect, correct,
  forget).
- **The outline is ambient.** Every agent perceives the live outline and writes
  anywhere via the existing command surface. No conversation binds a node.
- **"Session" disappears** as a user-facing/identity unit: it splits into a persistent
  **conversation log** (messages, per conversation), a **run log** (execution, per turn /
  task), and an ephemeral **per-turn assembly** (the invisible read seam) — §Data structure.

## Non-goals

- **Multi-member Channels in the first cut** (N agents in one room). Real
  subsystem; staged to P3, and even then **sequential turn-taking, not concurrent**
  (the concurrency collisions are the expensive part — see Adversarial review).
- **Proactive / initiative agents** (Cumora-style). Rejected — wrong for a
  focused outliner (AGENTS.md B10). Agents act only when addressed. **Carve-out:**
  the deferred completion notice of a *user-initiated* background task is **not**
  proactivity — it is the delayed result of a request (see §Background tasks).
- **Replacing the transcript / compaction machinery with memory.** Memory is
  **additive**; the existing compaction + tool-result-budget machinery keeps
  managing the live transcript (see Adversarial review §1).
- **Routing the main agent through the on-disk `AgentDefinition` registry in v1.**
  v1 needs the main agent to *have a stable identity to hang memory on*, not to
  *be constructed from an `AGENT.md` via the subagent path* (which is a
  ~1–2k-LoC refactor — §3). The roster/registry unification waits for real
  multi-agent need.
- **Back-compat / migration.** Pre-release, no prod data: change format, wipe
  `~/.lin-outliner-*` dev userData, and delete old `session` storage/API shapes
  rather than preserving migration aliases.
- No change to the document/node model or command mutation surface.
- No replacement of pi-agent-core (it stays the per-turn engine — §Runtime).
- **A user-configurable hooks subsystem.** Out of scope here. Notifications are a
  *trusted internal* consumer of a typed event bus; a pluggable / untrusted **hooks**
  layer is a separate future subsystem on the *same* bus (see §Background tasks →
  Hooks).

## Background — why this shape

The "new conversation / session list" paradigm is a **UX leak of the bounded
context window + LLM statelessness**, not a good interaction model. IM tools have
no "new session" because humans hold persistent compressed memory: the transcript
is a record, the brain is the working context. An LLM's working memory == its
context window, so the field invented sessions as a workaround. The fix is a
**memory layer** that makes sessions invisible, not copying sessions.

A second leak hides in the **output**: ChatGPT's "reply = result" puts the
deliverable in the chat bubble. That breaks for substantial artifacts — which is
why ChatGPT **Canvas** and Claude **Artifacts** later bolted a separate surface
beside the chat. Tenon has that surface natively, in more than one form (a node *or*
a file): the conversation carries communication, the artifact is the product (see
Core principle 5 and §Result routing).

Deep research (fan-out + adversarial verification) corroborated each pillar:
Letta "Stateful Agents" (2025-02, sessions as a baked-in stateless assumption) ·
MemGPT (arXiv 2310.08560, OS-paged memory for multi-session) · Anthropic
"Effective Context Engineering" (2025-09, context rot / attention budget) and
"Effective Harnesses for Long-Running Agents" (2025-11, externalize durable state,
compaction insufficient) · Mem0 (arXiv 2504.19413, bigger windows "delay rather
than solve") · CHI 2026 (arXiv 2509.11826, CRDT doc authoritative + named agent
personas) · **LoCoMo (arXiv 2402.17753, ACL 2024) — the honest ceiling**: neither
long-context replay nor RAG matches human long-term memory (~40–50pt gap); failure
modes are contamination, retrieval misses, topic bleed. Visible memory + trust
affordances are therefore required, not optional.

Reference implementations: **Rebecca** (`~/Coding/rebecca`, paused) — concept
skeleton (room "is not a session"; artifact ≠ chat; participant ≠ runtime
instance), but punts on memory (the part we must build). **Cumora** (cumora.ai) —
per-agent "climate" / relationship memory (validates per-agent memory); we reject
its proactivity. **cc-2.1 Dream** (`~/Coding/.research-repos/cc-2.1`) — production
memory consolidation (real-time `extractMemories` + offline `autoDream` over a
file store, perpetual "daily log → nightly dream" mode). Blueprint for the *write
pipeline*; we diverge on storage and on how forks work (§4 of Adversarial review).

## Core principles

1. **Identity travels, environment is local.** The agent (who + memory) is the
   same everywhere; the conversation only adds a local task overlay.
2. **One brain, many rooms.** One agent identity = one memory line, across all
   conversations.
3. **Distinct durable stores, distinct owners — they do not absorb each other**
   (conversation log · run log · memory line · outline; see §Data structure).
4. **Agent thick, conversation thin, outline ambient.** A place doesn't remember;
   the people in it do.
5. **Reply ≠ result.** The result is the durable product in its **natural form** —
   an outline node, or a file — written via the agent's tools; the **reply** is
   communication *about* it (a summary + a pointer), not the artifact dumped into
   the bubble. Conversation mode (advice, brainstorm, quick answers) still lives in
   the reply; artifact mode routes substantial deliverables to a node or a file. The
   agent picks the container; the user can override (see §Result routing).

## Concepts (final vocabulary)

| Concept | What it is | Owner |
|---|---|---|
| **Agent** | A role (prompt + tools + skills) + a single persistent identity + a memory line. | itself |
| **Principal** | A participant: `user` or `agent`. The one type used as member = actor = addressee. | — |
| **Conversation** | One primitive holding a message stream; **no stored `kind`** (§Data structure). | — |
| **DM** *(rendering)* | A conversation rendered 1:1 (you + one agent, no goal, canonical). Identity = the relationship. | participants |
| **Channel** *(rendering)* | A conversation rendered as a goal-room (1..N members + a `goal`). Identity = the goal. | the goal |
| **Member** | A `Principal` placed in a conversation. An edge, not an entity. | — |
| **Run** | The execution stream of one turn / task; anchored to exactly one conversation (§Data structure). | the running Agent |
| **Memory line** | Per-agent distilled memory, unified across conversations, private, relevance-retrieved, **visible**, **addressable** to source. | Agent |
| **Message stream** | The objective shared record of a conversation (messages only; execution → Run). | Conversation |
| **Distillation node** | A recorded summary over a *retained* span (`compaction.completed` generalized); lossy-but-addressable. Feeds navigation / recall / memory. | Conversation |
| **Outline / Node** | The **ambient** durable product — perceived live every turn. | user / workspace |
| **File** | A **non-ambient** durable product (PPT/PDF/export/code/image); produced via file tools, referenced & read on demand. | user / workspace |
| **Per-turn assembly** | Transient context for one turn (the read seam; the former "session" read side). | nobody |
| **Task** | An agent's **off-floor background Run** (long work); visible, stateful, posts its result back to the anchor conversation. | Agent (Run inside a conversation) |

**Member count is a property of a Channel (1..N), never a kind.** "single/multi
member" survive only as internal implementation-phase labels, never user-facing
names. Naming by headcount repeats the people-centric mistake; kind is intrinsic
(relationship vs goal).

**Coordinator is likewise a per-Channel role flag on a Member, not a kind nor a
new entity.** The same Agent identity is coordinator in one Channel and a plain
member in another (environment-local, like everything else a Channel adds). DMs
have none (Coordinator is Channel-only); a Channel's default coordinator = the main
agent. Mechanics in §Channel routing.

**Removed / collapsed:** `Session` → message stream + per-turn assembly;
`Participant` → `Member` edge; `Artifact` (noun) → **no separate entity; the product
takes its natural form** — an outline node (ambient) or a file (on-demand);
`boundNode` → outline is ambient; memory-as-node-subtree → memory is runtime
storage, not nodes.

## Design (code-grounded)

### Data structure → [[agent-data-model]]

The **authoritative** data model — the three storage families, the one-log-engine
(conversation / run / memory), the `Principal` / `ConversationMeta` / `MessageEvent` /
`RunMeta` / `DistillationNode` / `MemoryEntry` schemas, the distillation ladder, the
on-disk layout, the read/write seams, and the volatility/cache invariant — now lives in
**[[agent-data-model]]** (single source; [[agent-program]] F2/F6 cut their protocol
surface against it). Every "§Data structure" reference elsewhere in this plan resolves
here and forwards there.

The facts the rest of *this* plan leans on:

- **Three storage families**, each forced by one requirement: linear event log
  (conversation · run · memory — single-writer jsonl, agent-greppable) · CRDT/Loro (the
  outline document — two concurrent writers) · versioned file tree (skills). The agent
  part is the event logs; it does not touch Loro.
- **`session` → `{conversation, run}`.** Conversation log = the **communication** record
  (≈1 event/message; `MessageEvent.role` is `user | assistant` only). Run log = the
  **execution** detail (intermediate tool-calling turns, `tool_result`, thinking,
  deltas) — `tool_result` lives **only** in the run log. This keeps the conversation log
  low-volume and keeps `tool_call ↔ tool_result` pairs off the shared channel stream
  (the three-role pi-agent-core transcript is reconstructed at assembly, §Runtime).
- **Conversation = one primitive, no stored `kind`** (members + `goal` presence +
  canonical-ness); DM/Channel is a rendering + two product rules (§Conversations,
  §Adding an agent).
- **A run anchors to exactly one conversation**; `trigger` (message / node / parent /
  manual) is provenance, never the home — no conversation-less runs.
- **Ownership boundary:** a conversation owns the objective record (messages +
  summaries); an **agent owns its memory line** (per-agent, one global pool,
  pure-relevance — PM-ratified). The distillation ladder's top rung (conversation
  summary → agent `MemoryEntry`) crosses that boundary; summaries are
  **lossy-but-addressable** (every node carries a `source` down-pointer to retained raw).
- **Per-turn assembly** orders context by volatility (stable prefix → one volatile tail,
  never mutated), **mixed-resolution** (recent turns join the run log into a valid
  pi-agent-core transcript; old segments render as summaries — PM-ratified), driven
  through two seams: READ `deriveRuntimePiMessages` (`agentRuntime.ts:2414`), WRITE
  `handlePiAgentEvent` (`:2178`).

### The durable stores (summary)

| Store | Family | Owner | Content | Where (M0) |
|---|---|---|---|---|
| **Conversation log** | event log (segmented) | Conversation | objective record of what was said (messages) | `…/conversations/<id>/` |
| **Run log** | event log (bounded) | the running Agent | execution detail of a turn / task | `…/runs/<id>/` |
| **Memory line** | event log (additive) | Agent | distilled: knows / knows-whom / concluded | reserved `…/agents/<id>/memory/` |
| **Outline + history** | CRDT (Loro) | user | the product | unchanged (`commands.ts` / Loro, ambient) |

### Agent

Three layers; only the third is new infrastructure:

```
identity (authored)    name · @handle · avatar · role · voice
capability (authored)  system prompt · model + effort · tools + permission · skills
memory (accumulated)   the memory line — visible, editable, deletable
```

- **Capability binds to the agent, not the conversation.** Model + effort + tools +
  permission + skills travel with the agent identity into every conversation it
  joins; a conversation adds a task overlay (goal / focus) but **never overrides who
  the agent is** — exactly symmetric with the memory line. Model selection therefore
  moves from a global setting onto the **agent profile**. Sequencing: real
  `AgentDefinition` agents already carry these fields (`types.ts:702`), so per-agent
  model/config is **near-free at the type level** for specialist agents (the fields
  exist) — but verify the runtime actually threads `model`/`effort` into the
  conversation-turn assembly, not just at subagent spawn. The **main agent**'s model
  today resolves via `resolveProviderModel`/`resolveModel` (`agentRuntime.ts:1741`,
  `:3663`), wired in `createConfiguredAgent` (`:3276`), so its true per-identity
  binding rides the **same P3 registry unification** as §3 (until then it uses the
  default/global model).
- **v1 does NOT route the main agent through `AgentDefinitionRegistry`.** The main
  agent's construction spans 7 session-scoped layers an `AgentDefinition` cannot
  express (multi-section prompt `agentSystemPrompt.ts:15`; per-turn reminders
  `agentRuntime.ts:640`; permission classifier + approval handler ~`:3310,3345`;
  context manager 8-callback `:302`; provider/model/OAuth (`createConfiguredAgent :3276`); compaction + `/compact`
  `:388,625`). What v1 needs is far smaller: **a stable identity record** (the `agentId`
  tuple `sourceKind:sourceInstanceId:name`, not a bare display name — [[agent-data-model]]
  §3) that the memory line attaches to. Promoting the main agent to a real on-disk
  definition is deferred to P3 (when there is genuinely more than one agent).
- **Memory is not in `.agents/`.** Agent definitions there are read-only, loaded
  once at startup and cached (`agentSubagents.ts:1141,1255`), and may be
  git-tracked / dual-scoped (user `~/.agents` vs project `<ws>/.agents`). Mutable
  runtime memory must live in `userData/agent/agents/<agentId>/memory/`, keyed by a
  **stable identity tuple** (`agentId` = `sourceKind:sourceInstanceId:name`, where a project's
  `sourceInstanceId` is its workspace/root hash) so that not only user-vs-project but **two
  different projects' same-named agents don't collide in the global pool**
  ([[agent-data-model]] §3). Retrieval is global by default with opt-in isolation tiers
  (PM-ratified; §Memory model). Surfaced/edited in the profile UI; written via a
  **runtime-owned memory-append surface** (PM-ratified 2026-06-06) — an event-sourced
  append primitive, **not** `file_write`/`edit` (the file tools can't reach `userData`, and
  whole-file rewrite risks lost-update; §Memory model).

### Conversations: DM and Channel

```ts
// Authoritative shape: see §Data structure. No stored `kind`; DM/group is derived.
Conversation {
  id: ConversationId            // was sessionId
  members: Principal[]          // the staffing edge; the user is a member too
  goal?: string                 // a channel's goal = its render-time identity (a DM has none)
  anchors?: NodeId[]            // OPTIONAL navigation backlinks; never gate/scope/identity
  overlay?: string              // optional "what to do here"
  // message stream = segmented events.jsonl + branch structure (reused as-is)
}
// read cursors are a SEPARATE per-principal store (ReadCursors), NOT a conversation field — [[agent-data-model]] §3
```

DM vs Channel is a **rendering** (members + `goal` presence + canonical-ness), not a
stored type — see §Data structure.

**Conversation UX — DECIDED (PM-ratified 2026-06-05): canonical DM + user-creatable
Channels.** Each agent has **one always-on continuous DM** (no "new conversation" button
for DMs; find-or-create-unique). The **session list becomes the Channel list**: Channels
are the goal-scoped rooms the user creates / names / archives — that is where the
familiar "make a new conversation / fresh start" affordance lives now. So today's
`createSession`/`deleteSession`/`renameSession` surface re-targets to Channels, while the
DM is the persistent default thread. (Rejected: keeping a ChatGPT-style per-agent session
list — it re-leaks the context-window-as-conversations model.)

Thin: no memory, no traveling identity, no node binding. Don't give a conversation
a memory — a "channel summary" is an entry in some agent's memory line, tagged
with provenance. The branch structure (`childrenByParentId`, `selectedLeafMessageId`,
`agentEventLog.ts:515,516`) is a **single-agent retry affordance** — keep it for
DMs; rooms are linear (§Adversarial review §2).

**Addressing (`@`) is scoped to members.** The `@` candidate set is exactly the
conversation's agent `members` — like Slack / WeChat, autocomplete lists only who is
in the room. A **DM has no `@`** (the single agent is the implicit, default
addressee). A **Channel** lists only its agent members; you cannot `@` an agent that
is not in the channel.

- **`@` ≠ invite.** Bringing a new agent in is a separate **add-member** (roster)
  operation, not an `@`. *Optional convenience:* typing `@` on a non-member may
  offer "add them?" — but the default rule stays clean: `@` addresses members only,
  adding is its own action.
- **DM is intrinsically 1:1.** Adding a second agent does **not** convert it — there
  is no "DM with two agents"; it **spawns a new Channel** (the DM persists). See
  §Adding an agent.

### Adding an agent — spawn, don't convert

A DM never converts in place. Adding a second agent **spawns a new, seeded Channel**
(a goal + the existing agent as a member + an optional back-link to the DM); the
**DM persists**. Different identity kinds (relationship vs goal) don't morph into
each other, and the 1:1 stream stays private. This is cheap in our model because a
new Channel is a **warm start, not a cold one**: the agent's memory line + the
ambient outline already carry the context — only the verbatim DM transcript stays
behind (a record, recallable via `past_chats`).

A newly added agent onboards from **shared substrates only — never the private DM
transcript** — via a toolkit, each for a different need:

| Mechanism | Trigger | For | Granularity |
|---|---|---|---|
| **Ambient outline** | automatic | product / decisions already in the outline (the bulk) | full, free |
| **Coordinator briefing** | the coordinator (e.g. @assistant) | synthesized background, preferences | summary |
| **Seed at creation** | you, when creating | one-off handoff note | a paragraph |
| **Message forwarding** | you, anytime | "exactly these messages must cross" | surgical |

**Message forwarding** is a general IM primitive (any conversation → any
conversation, not just onboarding):

- **Combined / merged forward** — selected messages travel as **one bundle**, not
  message-by-message.
- **With a provenance marker** — the bundle lands in the target stream tagged
  "forwarded from `<source>`" (reuses the P1 `actor` / source attribution),
  visually distinct from natively-said messages; append-only, the source stream is
  untouched.
- It becomes **first-class context** for the target's agents (enters their per-turn
  assembly) and is re-distillable into their memory.
- It moves **communication**, not the product — the product is already shared via
  the ambient outline (dovetails *Reply ≠ result*).

Forwarding is **explicit, user-controlled disclosure** (you pick what crosses), so it
sidesteps the deferred auto cross-agent memory-sharing question — which stays the
default-private disclosure OQ.

### Channel routing — the coordinator (P3)

In a multi-member Channel, "who replies?" is resolved by a **coordinator** — not a
separate router subsystem, but **a Member with a role flag**. The rules:

1. **Explicit `@agent` → that agent.** The coordinator does not intervene — the
   common path, with zero extra cost. (Only channel `members` are `@`-addressable —
   §Conversations.)
2. **No `@` → the coordinator takes the turn.** It reads the message + channel
   context + its own memory line and decides.
3. **The coordinator may answer directly, or `@` a better-suited member to hand
   off.** Routing is just the coordinator's normal turn — **no separate routing
   model or prompt**. This is what keeps it simple.
4. **Hand-off is a relay, not concurrency.** The coordinator yields the floor; the
   addressed member takes it. Stays inside sequential turn-taking (§2) — none of the
   shared-session-state collisions apply.

Three constraints keep it clean:

- **Coordinator is a Member role flag, not a new Agent kind.** The same Agent
  identity can be coordinator in channel A and a plain member in channel B —
  coordinator-ness is **environment-local**, preserving *identity travels,
  environment is local*.
- **DMs have no coordinator** (the single agent is trivially the addressee).
  Coordinator is **Channel-only**.
- **Default coordinator = the existing main agent.** Smooth path: at P0/P1 it is
  the only member, hence trivially the coordinator; at P3, adding specialist members
  keeps it coordinator unless reassigned. No new machinery — *the agent you already
  have, now also triaging*.

Bounded by a **hop budget** (one user message relays at most N hops, then stops and
waits for the user) to prevent coordinator↔member ping-pong. Mis-routes are cheap to
recover: the decision is a **visible** channel message, corrected by `@`-ing the
right member.

It composes with the reference projects rather than copying any one:

- **Reactive "Convene" (vs Cumora).** This is the always-on, per-message form of
  Cumora's Convene primitive — the coordinator implicitly convenes the right member
  each message, with no manual gather and no timer-driven proactivity (which we
  reject, Non-goals).
- **Stacks with Slock's claim protocol.** The coordinator decides *who*; the
  addressed member *claims* the work before acting, so two members never double-work
  the same task. Orthogonal layers: decide-who, then claim-before-act.
- **Diverges from Rebecca on purpose.** Rebecca's rule is "no `@` = announcement,
  nobody responds." For a personal tool an unaddressed message usually *wants* an
  answer, so the coordinator picks it up instead of letting it fall into silence.

### Outline (ambient artifact)

Unchanged. Agents read/write any node via the command surface with `origin:'agent'`
(`agentNodeTools.ts:129`). Every agent perceives live outline state + the user's
current focus, supplied per-turn (already via `AgentUserViewContext`,
`agentTypes.ts:79`). No conversation owns or binds a node; "where work happens" is
the live moving focus.

### Result routing — reply, node, or file

The deliverable goes to its **natural form**, not always the chat bubble (the leak
in the ChatGPT "reply = result" model — §Background):

- **Outline node** — structured text/ideas that live in Tenon. Written via the
  command surface (`origin:'agent'`); **ambient**.
- **File** — anything whose natural form is a file (PPT, PDF, spreadsheet, image,
  export, code). Written via the existing file tools
  (`file_read/glob/grep/edit/write`, `agentToolPermissionRules.ts:212-245`) into the
  local workspace (`localFileRoot`, `agentTools.ts:178`); binary outputs already
  save-to-disk-and-reference (`agentWebTools.ts:358`). **Non-ambient** — read on
  demand. We do **not** force file-shaped work into nodes.
- **Reply** — conversational / ephemeral output (answers, explanations, clarifying
  questions, brainstorming). Here the reply *is* the value.

So the **reply is communication-shaped** — "what I did + where it is + what to look
at" — and it must be able to **point at the produced artifact**. Both reference
substrates already exist: node references (`referenceMarkup.ts` /
`nodeReferenceMarkersToText` / `formatNodeReferenceMarker`) and file references
(`binaryFile.filePath` / asset refs). What's missing is wiring them to a
**per-message** reference (a reply links the nodes/files it just produced, jump-to
on click) — required, because if the result lives outside the chat, an un-clickable
"it's in the outline / on disk" is *worse* than ChatGPT's inline result.

**Guardrail:** do not force everything into an artifact. The judgment line is *will
the user keep, edit, and re-reference this?* → artifact (node or file); *transient
answer / explanation / brainstorm?* → reply. The agent decides; the user overrides
("put that in the outline" / "just tell me, don't make a node").

### Memory model (revised: additive, not transcript-replacing)

- **Per-agent, unified, private, relevance-retrieved** (Generative Agents
  memory-stream + reflection; Letta). Not partitioned per conversation — failing
  to recall is "not retrieved," not "locked."
- **Injected ADDITIVELY, via the per-turn reminder stack** (`agentRuntime.ts:640`),
  alongside environment/outliner/user-view reminders — **not** by rewriting the
  transcript in `deriveRuntimePiMessages` / `transformContext`. The transcript
  derivation and the compaction / tool-result-budget machinery
  (`agentRuntimeContext.ts:153-372`) assume the full active-path transcript is
  present; replacing the transcript with memory desyncs them (§Adversarial review
  §1). Within-conversation shrinking stays the job of compaction; cross-conversation
  durability is the job of the memory line. They are complementary layers.
- **Storage:** `userData/agent/agents/<agentId>/memory/events.jsonl` — an
  **event-sourced** log (`memory.entry_added/updated/removed`) projected to the current
  `MemoryEntry` set; profile-visible/editable. Satisfies the trust affordances
  (inspect / edit / forget) that "retain everything" requires. (Shape: [[agent-data-model]]
  §3, §5.)
- **Write tiers, staged and honestly scoped:**
  - **v1 — inline, via a runtime-owned memory-append surface** (PM-ratified 2026-06-06,
    **reversing** the earlier "privileged `file_write` path"). The agent appends memory
    through a **runtime primitive** — *not* `file_write`/`edit`. **Why reversed:** the file
    tools are realpath-jailed to `workspace.root` (`agentLocalTools.ts:2207`), so they
    cannot reach `userData/agent/` at all; and whole-file rewrite + `fileWriteChains`
    only serializes I/O — it does **not** prevent a logical *lost-update* when a foreground
    turn and a background task both edit memory (the gemini review's concurrency case). An
    append-only, schema-checked, prompt-free runtime API sidesteps all three (no sandbox
    hole, no lost-update, no permission prompt) and honors self-mod's "don't use generic
    file write for runtime metadata." The memory index is injected each turn.
  - **v2 — extraction subagent.** A **dedicated** restricted agent definition
    (read + memory-write only) invoked via the `Agent` tool — **not** the implicit
    `fork` (which is `tools:['*']`, inherits the parent prompt, persists a
    transcript, and notifies the parent; `agentSubagents.ts:1219`). Needs a new
    definition + a host callback to feed it recent messages + throttling. Real
    build (~400–600 LoC), not "reuse the fork."
  - **v3 — offline consolidation ("reflect").** Gated merge/dedupe/prune/
    contradiction-resolve. Gate = time + activity + lock (cheapest first), the
    `autoDream` shape (`cc-2.1 .../autoDream.ts`).
- **Provenance tags:** `conversationId` / `runId` / `eventId` / `originWorkspace` —
  recorded for the addressable `sources` down-pointer, the visible-memory guard, and
  invalidation.
- **Retrieval: global by default, with opt-in isolation (PM-ratified 2026-06-06).** The
  default is one global pool, pure relevance (PM-ratified 2026-06-05). But because a
  confidential fact from project A could be relevance-retrieved into project B's prompt and
  sent to the external model — an NDA hazard raised in the gemini review — each agent gets
  opt-in **isolation tiers** over that default: `isolated` (retrieve only where
  `originWorkspace` == current) and `read-only-global` (read the global pool, but facts
  learned here don't enter it). `originWorkspace` is always recorded; the tier decides
  whether it scopes retrieval. Inspect / edit / forget remains the backstop.
- **Undo / branch invalidation (gemini review).** Memory is additive and cross-branch, so a
  fact learned on a branch later discarded or undone ("I finished feature X") would
  otherwise linger and contradict reality. Each `MemoryEntry` binds to its source
  `runId`/`eventId`; when that branch is discarded or its run undone, the entry is
  **soft-invalidated** (`status:'invalidated'`) and excluded from injection — not silently
  kept.
- **Raw signal = the conversation message streams** (no separate daily-log files;
  cc-2.1 needs them only because Claude Code lacks a structured store).
- **What not to save:** anything the outline already records (else memory and the
  document duplicate and pollute each other).
- **`past_chats` stays as raw-transcript recall** (rename sessions→conversations
  only) — but it becomes the **fine/raw layer** under the distillation ladder's
  **coarse** layer (§Data structure): `recall.overview` matches *summaries* with
  addresses, then `recall.expand` (or `past_chats`) drills to the raw span. It stays
  session/transcript-shaped by construction (search-index keyed by `sessionId:messageId`,
  `agentEventStore.ts:807`); the memory line remains a **separate** store with its own
  tool — don't "rewire past_chats into memory." Three distinct things: raw recall
  (fine) → segment summaries (coarse, addressable) → distilled memory.
- **Memory feedstock = the distillation ladder, not raw scraping.** Memory entries are
  distilled from **segment summaries** (one operation at increasing scope, §Data
  structure), and each entry keeps a `sources` down-pointer to the summary / message
  range it came from — so a fact is always traceable to ground truth (the
  contamination guard the LoCoMo ceiling demands).

### Skills (capability) — owned by agent-skills-authoring

Skills are part of capability and bind to the **agent identity, not the conversation**
(they travel into every DM/Channel the agent is in, like the memory line). Full design
in [[agent-skills-authoring]]; two facts this plan relies on:

- **One unified library, many bindings.** Skills live in shared stores
  (`built-in` / `user` / `project` / `dynamic`), not per-agent folders; an agent
  *binds* the ones it carries by name (`AgentDefinition.skills`, `agentSubagents.ts:640`).
  A Channel that needs skill X staffs a member who binds X — never a room-owned skill
  bag (that would reintroduce per-session config). So the coordinator's "who can do X?"
  is answerable per-member from binding lists (§Channel routing).
- **Governed self-authoring** is memory's sibling: an agent authors skills into the
  shared `user` store under review / audit / rollback, never the `built-in` floor,
  never self-escalating tools — see [[agent-skills-authoring]].

**Agent self-/cross-configuration (directional, owned here, not yet pinned).** The same
governed-write pattern as the memory line and skills extends to an agent editing its
own capability (prompt / model / effort / bound skills) and — at least the main agent —
configuring others. The single-agent `config` tool is built in
[[agent-self-modification]]; the **multi-agent "configure each other"** angle is this
plan's (it needs multiple agents → P3). Unresolved cut: **main-agent-first vs every
specialist self-configuring from the start** (Open questions).

### Runtime — pi-agent-core stays the per-turn engine

The redesign lives **above** the engine. `@earendil-works/pi-agent-core` runs one
turn (assembled messages + tools + model → loop) and exposes `transformContext`.
**Tenon already owns history and context**: `session.agent.state.messages` is
assigned from Tenon's `deriveRuntimePiMessages` (`agentRuntime.ts:690,716,741,765`);
`transformContext` delegates to Tenon's context manager (`:1092`). So the engine
owns no sessions, no history, no memory — the clean split holds: **engine =
stateless per-turn loop; Tenon = everything stateful above it.**

Memory plugs in at the **reminder stack** (additive, §Memory model), not by
mutating the transcript path. A turn:

```
you address an agent in a conversation
 → assemble: recent stream messages + triggering message
           + reminder stack { environment, outliner, user-view, MEMORY RECALL ← new }
           + live outline state (ambient)
 → pi-agent-core runs the loop
 → outputs: (1) reply → stream   (2) outline mutations → commands(origin:'agent')
 → (v1) the agent may write memory inline;  (v2/v3) extraction/consolidation distill into the memory line
```

"session" == the assembly step: built per turn, discarded, invisible.

### Background tasks — the off-floor plane

An agent can launch a **background task** (long work) without going silent: it hands
the floor back immediately ("working on X in the background, ask me anything") and
the foreground conversation stays live. A turn and a task run on **two planes**:

- **Floor** — the foreground conversation: sequential, one speaker at a time,
  always reachable.
- **Task plane** — detached runs, off the floor, parallel; they post back to the
  floor when done.

A task is **off-floor while running, on-floor only to deliver** — which is exactly
why a long task never blocks chat.

**The primitives already exist** — but *surfacing + unifying* them is a **real build,
not a freebie** (the §4 "reuse the fork" caution applies; the additions below + the
`AgentSessionState`-singleton split of §2 are substantial): background /
detached subagent runs with an `agent_id` addressable via `AgentStatus / AgentSend /
AgentStop` (`agentSubagents.ts:86-117,206`); a terminal-state callback
`notifyTerminalRun` (`:473,718`); a completion queue `pendingSubagentNotifications`
drained **only when the session is idle** (`agentRuntime.ts:1356,1364-1382`); a
background-shell `BackgroundTask` registry with `running/completed/failed/stopped` +
`task_stop` (`agentLocalTools.ts:274-289,335`); `AbortController` cancellation
(`agentStreamAbort.ts`).

**What the redesign adds:**

- A **unified, user-visible per-agent task panel** ("what is @assistant working
  on") aggregating runs across conversations, each tagged with its conversation;
  cancelable. (Today the registries are internal and split.)
- A **`needs-input`** state: a task that needs a decision pauses, posts the question
  into its conversation, and resumes on your reply (addressable via `AgentSend`).
  cc-2.1's `asyncRewake` (exit-code-2 wakes the model) is the proven shape.
- **First-class task-update messages** (provenance + a jump-to-artifact pointer),
  not a bare `systemReminder` blob.
- **A task is a `Run` with its own durable execution log** (`RunMeta` + `runs/<id>/`,
  §Data structure), **anchored to exactly one conversation** (`conversationId`,
  mandatory — where it reports). The **trigger** (`message` / `node` / `parent-run`) is
  orthogonal provenance, never the anchor: a scheduled routine fired by a `command` node
  still anchors to a delivery conversation, so there are **no conversation-less runs**.
  `runs WHERE conversationId=X` is complete; the per-agent panel is `runs WHERE agentId=X`.
- **Preserve isolation**: a background run must NOT share the foreground's session
  singletons (`activeRunId`, `toolOutputPayloads`, `lastSubmittedUserPrompt`,
  `skillRuntime`, `selectedLeafMessageId` — §2). Today isolation holds because a
  background run is a separate agent instance + the injection is idle-gated; giving each
  run its own log (above) makes the isolation structural rather than incidental (same
  thread as "split the `AgentSessionState` bundle").

**Notification / delivery.** Completion routes back to the **origin DM or Channel**
(the task carries its `conversationId`), in two layers:

- **In-stream message** (durable, always): the result as a first-class message in
  that conversation, authored by the agent — reuses the **`actor`** field landed at
  **P1** (§Code mapping).
- **Attention signal** (when you are not looking): an unread badge on that
  conversation + an optional OS notification.

Timing is **floor-aware**: the task ran off-floor, but *delivering* is an on-floor
event, so it **queues until that conversation's floor is idle** (the existing
idle-gate). The **P2 piece is DM delivery + the panel**; in a Channel, delivery
respects the coordinator/floor — which is **P3** (Channels/coordinator don't exist
earlier). Two cost tiers: a
**cheap status post** (no LLM — "task #3 done → [5 nodes]") or a **composed turn**
(the agent reads the result and writes a communication-shaped update; the existing
mechanism does this via `session.agent.prompt`). This also satisfies *Reply ≠
result*: the post is communication + a pointer to the node/file produced. The build
is to **generalize `pendingSubagentNotifications` from session- to
conversation-scoped** (reusing the **P1 `actor`** attribution), and add
**rate-limiting / folding**
(completion can flood — hermes uses watch-strike + a global circuit breaker; cc-2.1
folds / invalidates notifications; we only batch today).

**Cross-validated.** cc-2.1 and hermes independently converge on this shape:
queue + idle-drain + inject-into-origin-conversation (cc-2.1 `asyncRewake` /
async-hook attachments; hermes `completion_queue` drained after a turn and routed by
`watcher_chat_id`); background work surfaced as a **visible task** (cc-2.1 `DreamTask`
footer pill; hermes `process_registry`); and a **restricted-tool forked agent** for
background memory work (hermes whitelists memory+skill tools; cc-2.1 Dream) — exactly
§4's "dedicated restricted definition, not a full `tools:['*']` fork."

**Hooks (forward-pointer, out of scope).** Model the task/notification *trigger* as
a **typed domain event on the existing `AgentRuntime` emitter** (`agentRuntime.ts:1707`).
A future **hooks** subsystem (user-registered, pluggable handlers) is a *separate
consumer of that same bus* — **shared bus, separate dispatch + trust**. Two
differences a shared queue cannot paper over: hooks include **interceptors**
(synchronous, can block / mutate, e.g. PreToolUse-deny) vs notifications which are
async **observers**; and hooks expose an **untrusted extension surface** needing a
sandbox / trust gate (both cc-2.1's workspace-trust RCE gate and hermes's allowlist +
mtime re-validation confirm this). cc-2.1's hook-event enum (27 events incl.
`TaskCreated / TaskCompleted / Notification / SubagentStop / PreCompact`) is a ready
reference vocabulary when we build it. Caution: neither cc-2.1 nor hermes actually
built one clean bus — both fragmented into per-consumer registries; "design the event
taxonomy once" is the cleaner target, but the fragmentation pressure is real.

### What dissolves: Session

Splits **three** ways (§Data structure): the **conversation log** (messages, persists,
owned by the conversation), the **run log** (execution, bounded, owned by the running
agent — formerly inlined in the session), and the **per-turn assembly** (the ephemeral
read seam, owned by nobody). The per-session storage becomes the substrate, re-keyed by
conversation (messages), run (execution), and agent identity (memory).

### Prompt cache impact

The governing rule is the **volatility-ordering invariant** in §Data structure (stable
prefix → one volatile tail → never mutate the prefix). This subsection is its
cache-specific proof.

Verified against the engine. pi-ai uses Anthropic incremental caching —
`cache_control` is placed on the system prompt, the last tool definition, and the
**last user message's last block** (verified in the compiled provider,
`@earendil-works/pi-ai/dist/providers/anthropic.js:892-900,933`; upstream
`pi-mono/packages/ai/src/types.ts:410`), i.e. the breakpoint sits at the **tail**. The per-turn reminders (and the new MEMORY RECALL)
are pushed into the **current user turn's content** (`buildUserPromptMessage`,
`agentRuntime.ts:2673`) — the tail — and are **frozen into the persisted event**
(`appendUserPromptEvent`, `:662`); history replays verbatim (`deriveRuntimePiMessages`,
`:2414`), never re-rendered. Consequences:

- **P1 (memory via reminder stack) — cache-neutral-to-safe.** Memory recall lands
  *after* the cacheable prefix; frozen history keeps that prefix byte-stable turn
  over turn → hits continue. Critically, the **§1 decision (additive, not transcript-
  replacing) is itself a cache-protection decision**: the rejected "memory replaces
  transcript" would move the first divergence point to mid-array every turn →
  recompute the whole suffix. hermes makes the same call for the same stated reason —
  it injects memory into the user message *to preserve prompt cache*. **Caveat (must
  hold):** the provider only marks `cache_control` when the *last content block* of
  the user turn is `text`/`image`/`tool_result` (`anthropic.ts:1160-1164`), and
  `buildUserPromptMessage` appends attachments after the prompt
  (`agentRuntime.ts:2681-2695`) — so MEMORY RECALL must be a text block and nothing
  non-cacheable may end the turn, or the marker silently drops and the turn misses
  cache.
- **`session`→`conversation` rename — zero impact.** It changes storage keys, not
  the bytes sent to the model.
- **Per-agent capability — expected, not a regression.** Each agent's distinct
  system prompt is its own cache line; within one agent's conversations the prefix is
  stable. More agents = more cache namespaces, each independently cacheable.
- **P3 multi-agent floor-switching — the one real cost.** Each hand-off switches the
  system prompt *and* the per-agent POV-derived array (`forAgentId`, §2), so the
  prefix changes → **cache miss on each hand-off**; an agent's prefix goes cold while
  others hold the floor. Mitigate with **long cache TTL** (`cache_control.ttl: "1h"` /
  24h retention, `ai/src/types.ts:414,436`) and **deterministic POV derivation** (a
  returning agent's prefix must reproduce byte-for-byte). Inherent to interleaving N
  prompts — a cost to bound, not a bug to fix.

One honest tradeoff: freezing reminders is good for cache but means stale memory-
recall blocks linger in history; compaction (unchanged) eventually compresses them.

A second, **accepted** tradeoff (raised in the gemini review): at a segment-boundary
compaction, the just-sealed segment flips from verbatim to summary, so the **first turn
after that boundary takes a one-time prefix-cache miss** on the changed region. This is
the deliberate cost of boundary compaction (vs a sliding window's *constant* misses), and
it is bounded — it happens once per sealed segment, not per turn, and the retained raw
makes it non-destructive. Optional mitigation: a lightweight post-compaction prewarm
request. Not a blocker; do **not** try to keep both verbatim and summary cached (Anthropic
caching is a linear prefix — there is no independent second cache region to exploit).

## Adversarial review (stress-tested against the real code)

Four read-only investigations attacked the load-bearing claims. Findings and the
design response:

### §1 — "Memory replaces transcript replay via the transformContext seam" — REJECTED

The context manager (`agentRuntimeContext.ts:153-372`) is not a thin seam; it does
work that **assumes the full active-path transcript is materialized**:

- **Reactive compaction** preserves `session.lastSubmittedUserPrompt` and needs the
  live message array (`:202-224`).
- **Tool-result budgeting** initializes `toolResultBudgetState.seenIds` by scanning
  the full active path (`agentRuntime.ts:1084`) and re-scans each turn
  (`agentRuntimeContext.ts:303-356`) — replacing the transcript middle with memory
  makes IDs mismatch → missed slimming / undefined behavior.
- **Time-based microcompaction** depends on all assistant messages being in the
  active path (`:358-372`).
- **Compaction** preserves recent messages verbatim and records a `source`
  down-pointer range (`fromMessageId` → `throughMessageId`) from the active path;
  skipping events diverges the branch pointer from the materialized messages.
- **Checkpoints** assume a contiguous event log; **prompt cache** prefix stability
  is a hidden downstream constraint a per-turn-varying transcript would thrash
  (quantified in §Prompt cache impact).

**Response:** memory is **additive via the reminder stack** (`agentRuntime.ts:640`),
which is the existing, safe, per-turn injection path that does not desync any of
the above. The transcript and compaction stay exactly as they are. This is the
single most important correction in this revision — the earlier "memory replaces
transcript" framing would have broken compaction. (Independently confirmed: hermes
injects recalled memory **additively into the user message** rather than rewriting
history.)

### §2 — "Multi-member Channels (N-party stream)" — a real subsystem; do it SEQUENTIAL

- **Authorship used to be lost after replay.** M0 fixes the runtime foundation:
  `AgentEventMessageRecord` carries `actor`, and runtime-authored messages use the
  stable built-in assistant principal instead of implicit `'pi-mono'`. P3 POV work
  should build directly on that fact, not add a compatibility mapping layer.
- **POV derivation doesn't exist.** `deriveRuntimePiMessages` is a 1:1 role map
  (`:2414`); pi-agent-core expects `user→assistant→toolResult→user` alternation.
  An N-party room needs other members' turns mapped to `user`-role inputs from each
  agent's POV — a new `forAgentId` parameter on derivation.
- **Concurrency collides on shared session state.** `activeRunId`,
  `toolCallMessageIds`, `toolOutputPayloads`, `lastSubmittedUserPrompt`,
  `skillRuntime`, and the single `selectedLeafMessageId` are all per-session
  singletons (`agentRuntime.ts:240-270`). Concurrent multi-agent runs would clobber
  each other.

**Response:** P3 does **sequential turn-taking** (one member runs at a time, à la
Rebecca @mention chains), which dodges *all* the concurrency collisions — they are
concurrency bugs, not multi-agent bugs. Who actually replies is resolved by a
**coordinator Member** (§Channel routing): explicit `@` addresses directly,
un-addressed messages fall to the coordinator, hand-offs are sequential relays. The
genuinely required changes shrink to: **per-agent POV derivation** (on top of the P1
`actor` field) + threading per-member `agentId`, and **keep branching DM-only (rooms
are linear)** so no per-agent branch pointers are needed. The foundation is extensible (`childrenByParentId` is already
arrays `:515`; the event log is immutable), so this is "extend + parameterize," not
"rewrite." Still a real subsystem — hence P3.

### §3 — "Promote the main agent to AgentDefinition is small" — OVERSTATED ~10×

The main agent is constructed across 7 session-scoped layers that
`AgentDefinition` (`types.ts:702`) cannot express: multi-section system prompt
(vs single `body`, `agentSystemPrompt.ts:15`); 5 dynamic per-turn reminders
(`agentRuntime.ts:640`); session-bound skill/subagent runtimes (`:929`); permission
classifier + approval handler + session allow-rules (`:3310,3345`); the 8-callback
context manager (`:302`); provider/model/OAuth resolution (`resolveModel :3663` /
`createConfiguredAgent :3276`); `/compact` +
reactive retry + main-loop steering (`:388,625,3496`). Estimated ~1–2k LoC,
<30% reusable.

**Response:** v1 does **not** do this. The actual need is "the main agent has a
stable identity (the `agentId` tuple, not a bare `name`) the memory line attaches to" — a
tiny change. The full
registry unification is **moved to P3**, where it pays for itself (multiple real
agents). Genuinely reusable today: the permission system, compaction, and tool
factory are already shared/parameterized.

### §4 — "A cheap forked subagent extracts memory" — NOT what fork is

The implicit `fork` (`agentSubagents.ts:1219`) is `tools:['*']`, inherits the
parent system prompt, clones the parent messages, persists a transcript, can run in
background, and notifies the parent on completion. It is **not** restricted,
**not** prompt-cache-sharing (separate API calls / context windows), **not**
one-shot, **not** isolated. cc-2.1's `runForkedAgent` pattern does not map.

**Response:** v2 extraction is a **dedicated restricted agent definition** (read +
memory-write-only) invoked via the `Agent` tool, plus a host callback feeding it
recent messages, plus throttling — a real ~400–600 LoC build. Because of this cost,
**v1 (inline writes) should be carried as far as it can** before building the
extractor; v2 is justified only when inline writes provably miss too much.
(Confirmed by prior art: both hermes and cc-2.1 run background memory work as a
**restricted-tool** forked agent — hermes whitelists memory+skill tools, cc-2.1's
Dream — not a full `tools:['*']` fork.)

### §5 — Memory storage location & scope — UNDERSPECIFIED, fixed

`.agents/agents/<name>/` is read-only, startup-loaded, cached, possibly git-tracked,
and dual-scoped (user vs project). Putting mutable memory there conflicts (no
reload; config pollution; ambiguous "global" home; file-permission questions).

**Response:** memory lives in `userData/agent/agents/<agentId>/memory/events.jsonl`
(runtime, mutable, **event-sourced**), separate from read-only config, keyed by the stable
`agentId` tuple (`sourceKind:sourceInstanceId:name`). `past_chats` stays transcript-shaped
over conversations; the memory line is a separate store. No migration — wipe dev data.

## Code mapping (current → target)

**KEEP** — event store / replay / checkpoints / branches (`agentEventStore.ts`,
`agentEventLog.ts`) as the conversation stream; command mutation surface +
`origin:'agent'`; the **reminder stack** as the memory injection point;
compaction + tool-result budgeting **unchanged**; skills / tools / permissions;
pi-agent-core.

**M0 FOUNDATION** — `session` → `{conversation, run}`: the message stream
(communication) is split from the run log (execution); storage is keyed under
`conversations/<id>` **+** `runs/<id>`. M0.5 removes remaining IPC/API names that
still say `session`, so M1 code talks in `conversationId` / `runId` terms directly.
Conversation meta gains `Principal`-based `members`
(`cursors` is a **separate** per-principal store, not a conversation field) (**no stored
`kind`**); `RunMeta` records the conversation anchor + `trigger`; the main agent has a
stable identity record, **without** the registry refactor.

**BUILD** — the memory line: `agents/<agentId>/memory/` store + a memory tool +
profile UI (view/edit/forget) + the v1 inline-write prompt + reminder-stack
injection; later the v2 extraction definition and v3 consolidation. **The task
plane:** a visible per-agent task panel + conversation-scoped notification
(generalize `pendingSubagentNotifications`) + `needs-input`; the trigger modeled as
a typed event for a future hooks consumer (§Background tasks). **Skills structure +
self-authoring** are built in [[agent-skills-authoring]] (not here); this plan only
consumes binding (`AgentDefinition.skills`) for coordinator routing.

**Honest scope.** M0 covers the storage split, message actor, active-run state split,
stable identity, and domain bus. It does NOT cover: per-agent POV derivation,
branch-semantics for rooms, the main-agent registry refactor, mixed-resolution old
segments, or the memory subsystem. The real builds are the **memory line** and the
**sequential multi-member room layer**.

**Protocol-surface coordination (A4 / A7).** This plan's surface items — `actor` on
`AgentEventMessageRecord` (`src/core/agentEventLog.ts`), `forAgentId` derivation, the
`Principal` type + conversation `members` (with `cursors` as a separate per-principal
store) + `RunMeta` (no stored `kind`; `src/core/types.ts`) — are part of the
**consolidated M0 protocol-surface change list** in [[agent-program]] (which also
covers `SkillDefinition.source += 'built-in'`, the `user_question.*` / `widget_state`
events, etc. — the event taxonomy is decided there once). M1+ consumers must use the
target surface directly; do not preserve old session-shaped protocol branches.

## Phases (revised effort)

| Phase | Scope | Honest size |
|---|---|---|
| **P0** | Give the main agent a stable identity record — the `sourceKind:sourceInstanceId:name` **tuple** ([[agent-data-model]] §3), not a bare `name` — that memory keys off. **Not** the registry refactor. Pinning the full tuple here is what avoids the cross-project same-name memory collision (a bare `name` would reintroduce it). | small (incl. the tuple decision) |
| **P1** | **mixed-resolution assembly** in `deriveRuntimePiMessages` — join run logs for the recent window, render old segments as their (compaction) summaries; **canonical DM + user-creatable Channels** (conversation-list surface; DM find-or-create); **memory v1** (runtime-owned event-sourced append surface — *not* `file_write`; **global-default + opt-in isolation** retrieval; profile UI; reminder-stack injection). Single-member only. | memory v1 + channel UX on top of M0/M0.5 |
| **P2** | **Memory v2** — dedicated extraction subagent + host callback + throttling; provenance tagging. Only if v1 inline proves insufficient. | real build (~400–600 LoC) |
| **P3** | **Sequential multi-member Channels** — per-agent POV derivation + per-member `agentId` (on the P1 `actor` field), **coordinator-based turn-taking routing** (§Channel routing), rooms-are-linear; **the main-agent registry unification**; **memory v3** consolidation. | the big subsystem |

Single-member conversations (DM + a Channel staffed with one agent) deliver most
of the value — per-agent memory, DM/goal conversations, no session — without any
of the multi-agent machinery.

**Background tasks** span P2–P3: the visible per-agent task panel + notification
generalized session→conversation-scoped (with rate-limiting) can land at **P2**;
floor-aware delivery in Channels + `needs-input` wake ride **P3** (they need the
coordinator/floor). The **hooks** subsystem is out of this plan (forward-pointer in
§Background tasks).

**Skills** (structure + self-authoring) are built in [[agent-skills-authoring]] across
the same milestones (its `built-in` source is a program-M0 protocol add; authoring
lands at M1). **Agent self-/cross-configuration** is gated on the *who-configures-whom*
decision (Open questions); the single-agent `config` tool is [[agent-self-modification]].

## Rejected / reconsidered (decision record)

- **Memory replaces transcript replay** → rejected; breaks compaction / budgeting.
  Memory is additive via the reminder stack (§1).
- **"Promote main agent to AgentDefinition" as a small P0** → rejected; ~10× under-
  estimate. P0 is just an identity record; registry unification → P3 (§3).
- **Forked subagent as a cheap extractor** → rejected; fork is a full
  `tools:['*']` agent. v2 = dedicated restricted definition (§4).
- **Memory in `.agents/agents/<name>/memory/`** → rejected; config is read-only /
  dual-scoped. Memory → `userData/agent/agents/<agentId>/memory/` (§5).
- **Concurrent multi-agent rooms** → rejected for P3; sequential turn-taking
  avoids the shared-state collisions (§2).
- **No-router vs heavy-router for Channels** → both rejected; a **coordinator
  Member** (a per-channel role flag, default = the main agent) is the middle path:
  explicit `@` bypasses it (no chokepoint), un-addressed messages get a home, and
  routing = the coordinator's normal turn (no separate dispatcher). Sequential
  relay, hop-budget-bounded (§Channel routing).
- **DM → Channel conversion** → rejected; adding an agent **spawns a new seeded
  Channel**, the DM persists (different identity kinds; the 1:1 stream stays private;
  memory + ambient outline make it a warm start). A new member onboards from shared
  substrates only — ambient outline / coordinator briefing / seed / **combined,
  provenance-marked message forwarding** — never the private DM transcript
  (§Adding an agent).
- **Skill structure decisions** (rejected per-agent private storage; kept `project` —
  no `workspace` rename; `built-in` floor is not a "system skill" *category*) →
  moved to [[agent-skills-authoring]], which records them in its design.
- **memory-as-node-subtree, boundNode, Session/Participant/Artifact as concepts**
  → rejected earlier (see Concepts).

## Open questions

- **Disclosure judgment.** Unified per-agent memory makes "should this be said
  here?" a disclosure problem. Single-user: pure relevance, no rules. Multi-agent /
  multi-human: needs a discretion rule. Deferred.
- **Agent identity tuple / memory scope** — **DECIDED (PM-ratified 2026-06-05, refined
  2026-06-06).** Default retrieval = **one global pool, pure relevance**, keyed by the
  stable tuple `sourceKind:sourceInstanceId:name` (a project's `sourceInstanceId` = its
  workspace/root hash, so two projects' same-named agents don't collide). **Refinement
  (2026-06-06, from the gemini review):** because pure global retrieval can pull a
  confidential project-A fact into a project-B prompt sent to the external model (an NDA
  hazard), each agent gets **opt-in isolation tiers** (`isolated` / `read-only-global`) over
  the global default, with `originWorkspace` recorded on every entry. Inspect / edit /
  forget stays the backstop. Provenance (`sources`) records but does not by itself scope
  retrieval — the tier does.
- **Memory internal format.** Markdown topic files + index (simple, agent-writable)
  vs a structured store. Lean markdown.
- **Per-turn memory injection budget.** Whole index vs top-N by recency/salience;
  bound it (cc-2.1 caps MEMORY.md at 200 lines / 25KB).
- **Memory write — DECIDED (PM-ratified 2026-06-05, REVERSED 2026-06-06 after the codex +
  gemini review): runtime-owned append surface, not a privileged file path.** The earlier
  "permission-exempt `file_write`/`edit` into the memory store" is dropped — the file tools
  are realpath-jailed to `workspace.root` (`agentLocalTools.ts:2207`) and cannot reach
  `userData/agent/`, and whole-file rewrite + `fileWriteChains` serializes I/O but not
  logical *lost-update*. Instead memory is written through a **runtime-owned, event-sourced
  append API** (`memory.entry_added/updated/removed` → projection) — append-only,
  schema-checked, serialized, prompt-free, audited. Open sub-detail: whether that surface is
  a model-callable tool or a host-side callback the extraction path drives (§Memory model /
  [[agent-data-model]]).
- **Branch / edit / regenerate in rooms** — keep DM-only (P3).
- **Coordinator relay bound & surfacing.** The hop budget N (how many relays per
  user message before stopping), and whether a coordinator hand-off shows as a
  normal channel message or a quieter system line. Pin during P3.
- **Per-conversation capability override** — **decided: no** (capability is identity,
  §Agent). Tracked only as a watch-item, not an open decision: revisit solely if a
  real need ever forces an exception.
- **Who authors / configures whom.** Self-authoring (memory, skills, capability) is
  governed, but the *scope of the actor* is unpinned: **main-agent-first** (only the
  main agent self-/cross-configures) vs **every specialist self-configures from the
  start**. Directional/taste call for the PM; default to main-agent-first until a real
  need appears. (Skill-authoring mechanics — hot-reload, ratify/sandbox — live in
  [[agent-skills-authoring]].)
- **Result routing judgment.** The boundary between conversational output (reply)
  and an artifact, and between node vs file when it *is* an artifact — who decides
  (agent default + user override) and the draft gray zone ("draft an intro" → node?
  reply?). Pin the behavior in the v1 prompt.
- **Background-task open items.** Outline contention (a task editing nodes you are
  also editing — Loro merges *characters* but not *semantics*, so concurrent edits to the
  same node can corrupt structure or jump your cursor; the gemini review flags this). The
  task plane is M2, but the **node-occupancy marker** it needs (an "Agent is editing here"
  metadata flag + visual hint, optionally a soft-lock) is cheap and **worth designing into
  the M0/M1 node/command protocol** so M2 doesn't retrofit it. `needs-input` ordering when
  you are mid-topic; per-agent concurrency limits; **concurrent memory writes are now solved
  structurally** by the runtime append surface (append-only event log, no lost-update —
  §Memory model); notification rate-limiting / folding thresholds.
- **Conversation lifecycle** — delete / archive; a DM whose agent is removed; the
  add-member roster flow + the optional `@`-non-member prompt. (DM→Channel is
  decided: spawn a new seeded Channel, don't convert — §Adding an agent.)
- **Memory quality ceiling.** LoCoMo's ~40–50pt gap + contamination / retrieval
  misses are ongoing v2/v3 tuning, not solvable in one pass.
- **History-replay fidelity / mixed resolution** — **DECIDED (PM-ratified 2026-06-05):
  split now + mixed-resolution.** All execution (incl. `tool_result`) lives **only in the
  run log**, not the conversation log. Assembly replays **recent turns full** (joining each
  turn's run log to reconstruct a valid pi-agent-core transcript) and **old segments as
  their summaries**. Consequences (real, accepted): (a) `deriveRuntimePiMessages` must join
  run logs for the recent window — more upfront M1 work than full-replay; (b) the
  mixed-resolution old-segment rendering **reuses the existing compaction summaries**
  initially (the distillation ladder later), so the summary source exists at M1; (c)
  **behavior change** — the agent no longer re-sees old tool outputs verbatim, only their
  summary. This shapes the conversation/run boundary: the conversation log is
  communication-only.
- **Document context: snapshot+delta vs tail.** The live outline is volatile *and* large
  (the worst cache combination). Keep injecting it in the volatile tail (today), or cache a
  snapshot as a prefix layer + send only the Loro delta since the snapshot? Decide when
  memory-prefix lands (same volatility-ordering machinery).
- **Group default-`addressedTo`.** When the user `@`s no one in an N-member channel, who
  is addressed (all / none / last-speaker / the coordinator)? The coordinator is the
  current answer; pin the default with the channel work (P3).

## Checklists

P0 — identity
- [x] Give the main agent a stable `agentId` **tuple** (`sourceKind:sourceInstanceId:name`, not a bare `name`); thread it where memory will key off it.

P1 — conversations + memory v1
- [x] `session`→`{conversation, run}`: split the message stream (communication) from the run log (execution **incl. `tool_result`**); re-key `sessions/<id>` → `conversations/<id>` + `runs/<id>`; IPC, state map, scopes.
- [x] **Mixed-resolution assembly** (PM-ratified): `deriveRuntimePiMessages` joins the recent window's run logs into a valid pi-agent-core transcript and renders old segments as their (compaction) summaries — the agent no longer re-sees old tool outputs verbatim.
- [x] `Principal` type; `members` on the conversation record (`meta.json` = projection of membership events; `cursors` a **separate** per-principal store) — **no stored `kind`** (DM/group derived from members + `goal`). `RunMeta` with mandatory `conversationId` anchor + `trigger` provenance.
- [x] Store `actor` on `AgentEventMessageRecord`; drop implicit `'pi-mono'` by parameterizing runtime-authored agent actors — foundation for task-notification attribution + P3 POV.
- [x] **Canonical DM + Channels** (PM-ratified): one find-or-create DM per agent (no "new conversation" for DMs); re-target the `createSession`/`deleteSession`/`renameSession` surface to **Channels**; single-staffed Channel creation.
- [x] Distillation backbone: make `compaction.completed` a multi-consumer node with an explicit both-ends `source` range (raw retained, already non-destructive). Coarse `recall.overview`/`recall.expand` over summaries is later (P2+), but the addressable range lands here.
- [ ] "Add agent" spawns a new seeded Channel (no in-place conversion); combined, provenance-marked message forwarding (any conversation → any conversation).
- [x] `agents/<agentId>/memory/events.jsonl` store (event-sourced) + a **runtime-owned memory-append surface** (append-only, schema-checked, serialized, prompt-free — *not* `file_write`); **global-default retrieval + opt-in isolation tiers** (`isolated`/`read-only-global`), `originWorkspace` recorded; `MemoryEntry` binds source `runId`/`eventId` for undo-invalidation.
- [ ] Inline memory write instructions in the agent prompt.
- [x] Memory recall added to the per-turn reminder stack (`agentRuntime.ts:640`); index budget bounded; `sources` down-pointer recorded (for the visible guard, not retrieval scoping).
- [ ] Profile UI: view / edit / forget memory.
- [x] M0.5 clean cut: rename/remove remaining agent `session*` protocol/index/API
  bridge debt, then wipe dev userData (format change, no migration).

P2 — memory v2 + background-task surfacing
- [ ] Dedicated restricted extraction agent definition (read + memory-write only).
- [ ] Host callback feeding recent messages; throttle; provenance tags (conversation/node/workspace).
- [ ] Visible per-agent task panel (runs aggregated across conversations, cancelable).
- [ ] Generalize `pendingSubagentNotifications` → conversation-scoped delivery (reusing the P1 `actor` field) + first-class task-update messages + rate-limiting/folding. (DM delivery; Channel/coordinator delivery is P3.)

P3 — sequential rooms + consolidation + registry
- [ ] `forAgentId` POV derivation in `deriveRuntimePiMessages` (others' turns → user-role); thread per-member `agentId` into the P1 `actor` field (N-agent authorship).
- [ ] Sequential turn-taking routing; rooms-are-linear (no per-agent branch pointers).
- [ ] Channel routing: coordinator Member role flag (default = main agent); explicit `@` bypasses, no-`@` → coordinator, hop-budget-bounded relay; coordinator reassignable per channel.
- [ ] Promote the main agent through `AgentDefinitionRegistry` (the ~1–2k-LoC refactor).
- [ ] Long cache TTL + deterministic POV derivation for floor-switching (§Prompt cache impact).
- [ ] Floor-aware task delivery in Channels + `needs-input` wake (asyncRewake-style); keep background-run isolation from session singletons.
- [ ] Offline consolidation pass (gated time + activity + lock).
