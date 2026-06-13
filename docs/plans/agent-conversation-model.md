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

**Status (2026-06-12).** The M0 seams + the M1 spine **landed** (#150–#153: identity /
`actor` / conversation↔run split, canonical DM + Channels, the memory line, mixed-resolution
assembly); M2 background visibility **landed** (task panel #160, notifications #166) — design
folded into `docs/spec/`. **The M3 multi-agent spine also landed** — working Channel +
coordinator routing (#179 M3-A), cross-agent memory + isolation gate (#200 M3-B), per-agent
POV inspector (#212 M3-C), plus the parallel-execution upgrade (#202); the M3 sequence is
**complete** (see `agent-program` § *M3 sequencing & readiness* and `agent-architecture`).
**The one remaining item — mid-run `needs-input` — is deferred by decision** (tracked in
`agent-program` M2). With M0–M3 all shipped and folded into spec, this plan is effectively
complete; it is kept `in-progress` as the live design authority for that deferred tail.

## Goal

- **Agents are first-class, durable identities** carrying their own memory. An
  agent is the same identity across every conversation it is in.
- **Conversations are one primitive (members + optional Channel name), not a stored kind.**
  "DM" (1:1, identity = the relationship) vs "Channel" (named room, identity =
  the room name) is a **rendering** derived from canonical-DM identity vs
  Channel-name presence (§Data structure) — not a `kind` enum. The current event
  vocabulary still stores the Channel name in the legacy `goal` field.
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
  **Revised 2026-06-11 (PM):** serialized execution was an M3-A staging
  simplification, not the product model — co-addressees are semantically
  independent (the independence cut), so concurrent execution +
  completion-order delivery changes no agent's words, only timing. It is now
  planned as a pure execution-layer upgrade:
  `docs/plans/agent-channel-parallel-runtime.md`.
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
| **Channel** *(rendering)* | A conversation rendered as a named room (user + coordinator by default, optional invited agents; stored in the legacy `goal` field). Identity = the Channel name. | the Channel name |
| **Member** | A `Principal` placed in a conversation. An edge, not an entity. | — |
| **Run** | The execution stream of one turn / task; anchored to exactly one conversation (§Data structure). | the running Agent |
| **Memory line** | Per-agent distilled memory, unified across conversations, private, relevance-retrieved, **visible**, **addressable** to source. | Agent |
| **Message stream** | The objective shared record of a conversation (messages only; execution → Run). | Conversation |
| **Distillation node** | A recorded summary over a *retained* span (`compaction.completed` generalized); lossy-but-addressable. Feeds navigation / recall / Dream span location. | Conversation |
| **Outline / Node** | The **ambient** durable product — perceived live every turn. | user / workspace |
| **File** | A **non-ambient** durable product (PPT/PDF/export/code/image); produced via file tools, referenced & read on demand. | user / workspace |
| **Per-turn assembly** | Transient context for one turn (the read seam; the former "session" read side). | nobody |
| **Task** | An agent's **off-floor background Run** (long work); visible, stateful, posts its result back to the anchor conversation. | Agent (Run inside a conversation) |

**Channels are named rooms; DMs are agent relationships.** A user + one specific
agent relationship is always the canonical DM. A Channel can be created as a
named room before extra invitations: it starts with the user and the coordinator
agent, then optional invited agents can be added later. This matches the
Slack-like room-first flow and keeps "I want a place called X" distinct from "I
want to talk to agent Y."

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
- **Conversation = one primitive, no stored `kind`** (members + Channel-name
  presence, currently stored in the legacy `goal` field, plus canonical-ness);
  DM/Channel is a rendering + two product rules (§Conversations, §Adding an agent).
- **A run anchors to exactly one conversation**; `trigger` (message / node / parent /
  manual) is provenance, never the home — no conversation-less runs.
- **Ownership boundary:** a conversation owns the objective record (messages +
  summaries); an **agent owns its memory line** (per-agent, one global pool,
  pure-relevance — PM-ratified). Distillation summaries stay on the conversation
  side of the boundary; Dream may use them to locate candidate spans, but must read
  raw conversation/run evidence before writing an agent `MemoryEntry`. Summaries are
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
  joins; a conversation adds a task overlay (room name / focus) but **never
  overrides who the agent is** — exactly symmetric with the memory line. Model selection therefore
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
  goal?: string                 // legacy field carrying a Channel's display name (a DM has none)
  anchors?: NodeId[]            // OPTIONAL navigation backlinks; never gate/scope/identity
  overlay?: string              // optional "what to do here"
  // message stream = segmented events.jsonl + branch structure (reused as-is)
}
// read cursors are a SEPARATE per-principal store (ReadCursors), NOT a conversation field — [[agent-data-model]] §3
```

DM vs Channel is a **rendering** (canonical DM id vs Channel-name presence), not
a stored type — see §Data structure.

**Conversation UX — DECIDED (PM-ratified 2026-06-05): canonical DM + user-creatable
Channels.** Each agent has **one always-on continuous DM** (no "new conversation" button
for DMs; find-or-create-unique). The **session list becomes the Channel list**: Channels
are the named rooms the user creates / renames / archives — that is where the
familiar "make a new conversation / fresh start" affordance lives now. So today's
`createSession`/`deleteSession`/`renameSession` surface re-targets to Channels, while the
DM is the persistent default thread. (Rejected: keeping a ChatGPT-style per-agent session
list — it re-leaks the context-window-as-conversations model.)

Thin: no memory, no traveling identity, no node binding. Don't give a conversation
a memory: a channel summary remains a conversation-owned distillation node until a
runtime memory writer reads the raw evidence and records an agent-owned
`MemoryEntry` with provenance. The branch structure (`childrenByParentId`, `selectedLeafMessageId`,
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
- **DM is intrinsically 1:1.** Adding an agent does **not** convert it — there
  is no "DM with two agents"; it **creates a new named Channel** with the current
  DM agent preselected (the DM persists). See §Adding an agent.

### Adding an agent — spawn, don't convert

A DM never converts in place. Escalating a DM **creates a new named Channel**
with the source DM agent preselected and an optional opening message; the **DM
persists**. Different identity kinds (relationship vs named room) don't morph
into each other, and the 1:1 stream stays private. This is cheap in our model
because a new Channel is a **warm start, not a cold one**: the agent's memory line
and the ambient outline already carry the context — only the verbatim DM transcript
stays behind (a record, reachable only through internal evidence search /
explicit provenance expansion, not a public `past_chats` tool).

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
   shared-session-state collisions apply. **(2026-06-11: the routing shape is
   unchanged under the parallel runtime — a hand-off target is still addressed
   by the completed reply; it just dispatches on that reply's completion,
   concurrently with unrelated in-flight runs.)**

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
- **Write authority — DECIDED (PM-ratified 2026-06-07):** because Lin has not
  shipped, cut directly to the target architecture: remove the model-visible
  inline `memory` write tool instead of preserving, wrapping, or aliasing it. The
  durable memory line is written by **exactly two runtime-owned writers**:
  Settings/Profile UI for explicit user edits, and Dream/extraction for automatic
  long-term consolidation. There is no model-visible write tool and no direct
  foreground write path. The foreground main agent consumes `<agent-memory>` and
  the read-only `recall` tool, but does not curate durable memory. **Why:** the
  foreground turn is optimized for solving the current task, so letting it decide
  long-term writes overfits transient context, encourages over-memory, and mixes
  short-term problem solving with durable state management. Update/forget also
  requires dedupe, conflict checks, provenance review, and workspace-scope
  enforcement — all better handled by a serialized runtime writer. The append
  surface remains the right primitive: event-sourced, schema-checked, serialized,
  audited, and not `file_write`/`edit`.
- **Dream / extraction writer (M2).** A dedicated runtime-owned worker may use a
  restricted model call, but it is **not** the main agent's inline tool and **not**
  the implicit `fork` (which is `tools:['*']`, inherits the parent prompt,
  persists a transcript, and notifies the parent; `agentSubagents.ts:1219`). It
  reads bounded raw conversation/run spans, proposes add/update/forget memory
  events, dedupes/conflict-checks against the current memory line, and appends
  through the same runtime memory API with provenance.
- **Implemented Dream thin assembly:** Dream write-back is a scheduled/manual
  reflective run, not a per-turn stop hook. The automatic path uses the shared
  `date` schedule primitive plus a minimum-evidence gate; `/dream` forces the
  same no-tools path and consolidates existing memory when there is no new raw
  evidence. Dream reads raw conversation/run events since its watermark, appends
  memory events through the runtime store, records `dream.completed`, and writes
  agent-anchored reflective run meta. It intentionally does not use cc-2.1's
  file-writing extraction agent because Tenon's clean write boundary is the
  event-sourced memory store.
- **Offline consolidation follow-ups.** The first Dream pass already supports
  merge/dedupe/prune/contradiction proposals over visible memory. Deeper task
  panel observability, backlog chunking, and future summary/search locator
  optimizations remain follow-up work.
- **Provenance tags:** `conversationId` / `runId` / `eventId` / `originWorkspace` —
  recorded for the addressable `sources` down-pointer, the visible-memory guard, and
  invalidation.
- **Retrieval: one undivided pool (PM-ratified 2026-06-06; REVISED 2026-06-10).** The
  default is one global pool, pure relevance (PM-ratified 2026-06-05). The 2026-06-06
  gemini-review NDA concern added an opt-in `isolated` tier (retrieve only where
  `originWorkspace` == current), but it was **removed 2026-06-10**: a principal, like a
  person, does not partition its own memory by where it works, and the tier had become
  write-partitioned/read-global in practice. `read-only-global` (read the pool, pause new
  writes) remains; `originWorkspace` is always recorded as provenance only.
  Inspect / edit / forget remains the backstop.
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
- **Single model-visible read tool — DECIDED: `recall`.** There is no
  model-visible `past_chats`, no second raw-chat search tool, and no transcript-
  shaped public history surface. Raw transcript search remains necessary, but
  only as an **internal evidence search** service over conversation messages and
  run events. The model-facing `recall` tool returns durable `MemoryEntry`
  results, each with provenance. `include_evidence` defaults to `false`; when
  `true`, raw conversation/run excerpts are included only as an `evidence[]`
  child field nested under the matching memory entry. Evidence is never returned
  as a sibling item in the ranked result list, and raw logs can only be expanded
  through a memory entry's provenance. `recall` filters out `status:'invalidated'`
  entries and respects a host-bounded `max_chars` cap for the full result (no
  workspace filtering — the pool is undivided, D2 revised 2026-06-10). **Accepted consequence:** older conversations that never produced a
  `MemoryEntry` are not recallable by the foreground model by design; they remain
  available only to internal evidence search, debug/review UI, and Dream's
  controlled extraction path. Three distinct layers stay separate: raw evidence
  search (fine/internal) → segment summaries (coarse, addressable) → durable
  memory entries (agent-owned).
- **Dream evidence = raw conversation/run record; context-management summaries
  are locators, not evidence.** Distillation summaries are lossy objective
  compression, written to *continue a task*. They are
  useful as a map to find likely spans and bound cost, but Dream must read the
  original messages and relevant run events before writing long-term memory.
  **Why:** extracting memory from summaries would train the system on a model's
  interpretation of a model's interpretation, amplifying omissions, softened
  user corrections, and topic bleed. A `MemoryEntry` can cite a summary as an
  index hint, but durable facts need raw `conversationId` / `messageRange` /
  `runId` / `eventId` provenance. *(Restated 2026-06-10: this rule binds
  context-management artifacts; memory-owned episode gist is a different
  product and IS the consolidated evidence carrier — authority:
  [[agent-memory-foundations]] §2, lands in realignment PR-2.)*

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
 → optional read-only recall returns MemoryEntry results
    (+ nested evidence only when include_evidence:true)
 → Settings/Profile + Dream write the memory line; the main agent consumes it
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
  - Current first slice shipped: the renderer exposes a current-conversation task
    panel for `subagent_run` projection records, with open-details and stop
    actions. Cross-conversation per-agent aggregation and non-subagent task
    adapters remain M2 work.
- A **`needs-input`** state: a task that needs a decision pauses, posts the question
  into its conversation, and resumes on your reply (addressable via `AgentSend`).
  cc-2.1's `asyncRewake` (exit-code-2 wakes the model) is the proven shape.
  **Scoped by the 2026-06-08 decision below**: this is for a conversation's own
  *foreground* agent, never a *subagent* — subagents run to completion and never
  question the user mid-execution.
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

**Shipped (M2 delivery slice).** A detached subagent terminal now emits a durable
`notification.created` anchored to its origin conversation (`kind` =
`task_completed|failed`, `source = {subagent}`; a user-initiated **stop** raises no
notification — it is the user's own action), idempotent and restart-safe
(`docs/spec/agent-event-log-rendering.md` §Notification + attention projection). The
notification id keys on the completion instant (`notification-<runId>-<completedAt>`)
so a **resumed** detached run that finishes again is delivered, not dropped as a stale
duplicate. A subagent left **running when the app dies** is marked failed AND raises
its durable notification on the next restore (the "don't go silent" case). Attention
folds per conversation into `attentionByConversationId` unread counts; notification
events never bump the conversation's `updatedAt` (no list reorder / timestamp change).
The count is pushed to the renderer over a `conversation_attention` runtime event (in
`agentTypes.ts`, **not** `core/types.ts` — stays off the sibling scheduled-routines
lane's protocol surface) and rendered as a neutral unread badge on the conversation
list; the persisted unread is folded incrementally on the conversation index (no
full replay per delivery) and **seeded on launch** for listed conversations so a
badge survives restart before its conversation is reopened. Marking a conversation
read is an **explicit "the user can see it" signal** (dedicated
`lin:agent-mark-conversation-read` IPC + `markConversationRead`), driven by the
renderer only when the **agent dock is actually open** (it collapses CSS-only while
keeping the conversation loaded, so "loaded" ≠ "viewed") showing that conversation —
**never** by a config reload (which also restores). The optional OS notification is
wired through an injectable `OsNotifier` (`agentRuntime.setOsNotifier`) to a native
Electron `Notification`, gated on a self-contained opt-in preference (default OFF,
folded into the shared `appPreferences` store, read synchronously); it is suppressed
only when the user is actually looking at that task's conversation (window focused
**and** it is the renderer-reported *viewed conversation* — dock open showing it),
truncates its body, and routes a banner click to the originating conversation. The
existing idle-gated `pendingSubagentNotifications` model-injection stays as the
live-session composed-turn layer.

**DECIDED (PM, 2026-06-08): subagents never ask the user mid-execution.** A
subagent is invoked *only* when its information and goal are clear enough to run to
completion as a background task; it reports back on completion and never pauses to
question the user. The user's interaction surface stays **one locus** (the
foreground main agent / the current conversation) so attention is not scattered
across many objects. Clarification happens **before** hand-off: the main agent uses
`ask_user_question` with the user up front (foreground, shipped #153), and a
subagent may ask its **main agent / channel** (agent↔agent) to clarify the task
*before* formal execution — never agent↔user, never mid-execution. This is
consistent with the restricted background-worker model (cc-2.1 Dream / hermes
allow-listed memory+skill tools — no user-question tool on the background surface).
Consequence: **do not** wire `ask_user_question` into `createSubagentAgent`, and do
not build a subagent→user `needs_input` trigger. The `needs_input` notification
`kind` stays reserved only for a conversation's **own foreground agent** awaiting a
user decision while the user is in a different conversation (a minor cross-
conversation attention case, not built yet). Agent↔agent task clarification and
multi-agent routing are the **P3 coordinator / Channel** work, out of M2.

**Companion (PM, 2026-06-08): clarity is the publishing agent's job; the terminal
result is the clarification channel; recovery is re-spawn, not resume.** Task
clarity is owned **up front by the agent that publishes the task** (it decomposes
and, if needed, clarifies with the user in the foreground *before* spawning). A
subagent's **terminal result is itself a clarification channel**: faced with an
unclear task or a mid-run discovery that critical information is missing, it **may
refuse or stop — surfacing as a failed/clarifying terminal run** rather than
guessing. (Default behavior, though, is to **infer the most likely goal from
context and proceed**; bailing is for genuine blockers, not mild ambiguity.) The
failure/result is delivered back to the origin conversation by the shipped
notification path (`kind: 'task_failed'`/`'task_completed'`, the clarifying reason
in the body). **Recovery is to create a NEW, clearer task — not to resume the
stopped one.** The main agent (or the user, having supplemented context in the
DM/Channel) spawns a fresh, better-specified run. This deliberately **avoids
mid-execution pause/resume entirely**, which sidesteps the hard restart-resume
problem (the run log re-spawn + answer-injection that `needs-input` would have
needed): there is nothing to resume — failed tasks just fail, and a clearer one
replaces them.

**Remaining.** (1) The **cheap status-post** row (no-LLM in-stream task-update
message) and cross-conversation panel aggregation. (2) Rate-limit / fold
**thresholds** beyond the current per-conversation fold.

**Cross-validated.** cc-2.1 and hermes independently converge on this shape:
queue + idle-drain + inject-into-origin-conversation (cc-2.1 `asyncRewake` /
async-hook attachments; hermes `completion_queue` drained after a turn and routed by
`watcher_chat_id`); background work surfaced as a **visible task** (cc-2.1 `DreamTask`
footer pill; hermes `process_registry`); and a restricted background surface for
memory work (hermes whitelists memory+skill tools; cc-2.1 Dream) — exactly §4's
"runtime-owned restricted worker, not a full `tools:['*']` fork."

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

### Cross-agent help — consultation is a colleague call, not a privilege

**DECIDED (PM, 2026-06-13): an agent is an autonomous colleague, not a sandboxed
tool.** When an agent needs a specialist it follows the human-team model: it
privately consults a colleague, gets a bounded result, and stays accountable for
the final reply. Three rules keep this safe without making it bureaucratic.

**1. Contact is a universal baseline; capability is per-agent.** Two permission
axes that must never be conflated:

- *Contact* — whether an agent may consult another agent — is **mutual and
  ungated**, like any colleague being reachable. It is **not** a per-act,
  user-approved privilege, and there is **no per-agent "who-can-consult-whom"
  allow-list**.
- *Capability* — what a given agent may **do** (its tools/permissions) —
  legitimately **differs per agent**, and is where safety lives. A consulted
  agent runs under **its own** identity, tools, permissions, memory and judgment
  (`agentDelegation.ts:615-620`); the caller borrows nothing. A read-only agent
  consulting a powerful one gains no power — it gets the powerful agent's
  considered result, and that agent stays accountable for using its own
  authority. The consultee's risky actions still gate through **its own**
  permissions and surface to the user (today via the parent conversation's
  approval UI — it should be attributed to the consultee). This is the
  *permission-approval* surface, **not** a clarifying question: the 2026-06-08
  "subagents never ask the user mid-execution" rule still holds.

**2. Trust is set at the team level.** The user's configured agents are the team;
within the team any agent may consult any agent. `disabledAgents` is the
team-roster switch (an agent is on/off — `agentDelegation.ts:603-605`), **not** a
per-pair gate. No allow-list machinery.

**3. A consultation is a sidechain, not a membership change.** It is a fresh
child run: the consulted agent does **not** join the conversation, speak in it,
or get injected into the transcript; the DM stays 1:1 and the caller owns the
reply. **Visible** participation is a different thing — that is a **Channel** (you
add an agent to the room). A persistent agent↔agent relationship thread (a "DM
between two agents") is not wrong under the colleague model, but it is a much
larger build (it reopens membership, memory visibility, retention, search,
list-surface) and is **deferred**; v1 consultation is one-shot runs — **no stored
relationship and no new conversation `kind`**.

**Already true (no build).** Fresh-child identity/permissions/memory-owner
(`agentDelegation.ts:615-620`), per-principal Dream isolation, sidechain
rendering + the Task Panel's observability, and the runaway guards — depth
(`DEFAULT_MAX_DELEGATION_DEPTH = 3`), cycle detection (ancestry path), concurrency
cap (`MAX_CONCURRENT_CHILD_RUNS = 4`) — are all in place
(`agentDelegation.ts:1197-1228`). These guards are exactly what makes ungated
contact safe.

**Build note (the one divergence).** `agent.delegate.spawn` currently defaults to
`'ask'` in `balanced`/`ask_first` (`agentPermissionModel.ts:91,151-163`) — contact
is still gated per-act. The intended posture is **baseline-allow**; safety stays
on each agent's own capability permissions + the guards above. This is a
security-sensitive default change → its own small, PM-ratified PR. Surfacing
polish (framing a run as "consulted @B" vs a generic task; a user-facing "consult
@X" entry) is **deferred** — the Task Panel already makes consultations
observable.

**Relationship to `/research`.** Generic research is the agent using its **own**
capability (a read-only `context: fork`), not a consultation — no second
principal. Consultation is for when a real **specialist's** judgment is the point.
(See the `research-skill` plan / #232.)

This consolidates and supersedes the closed `agent-private-consultation`
exploration (#233).

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
concurrency bugs, not multi-agent bugs. **(2026-06-11: dodging was the M3-A
stage; the collisions are now scheduled to be repaid — per-run active state,
scoped stop, shared-state audit — in
`docs/plans/agent-channel-parallel-runtime.md`.)** Who actually replies is resolved by a
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

**Response:** Dream/extraction is a **dedicated runtime-owned worker** with a
restricted model surface, plus a host callback that feeds bounded raw
conversation/run spans and enforces throttling. Since Lin has not shipped, remove
the foreground inline memory writer cleanly instead of keeping a compatibility
path: the main foreground agent should consume memory, not directly curate
durable memory. (Confirmed by prior art: both hermes and cc-2.1 run background
memory work as a restricted surface — hermes whitelists memory+skill tools,
cc-2.1's Dream — not a full `tools:['*']` fork.)

### §5 — Memory storage location & scope — UNDERSPECIFIED, fixed

`.agents/agents/<name>/` is read-only, startup-loaded, cached, possibly git-tracked,
and dual-scoped (user vs project). Putting mutable memory there conflicts (no
reload; config pollution; ambiguous "global" home; file-permission questions).

**Response:** memory lives in `userData/agent/agents/<agentId>/memory/events.jsonl`
(runtime, mutable, **event-sourced**), separate from read-only config, keyed by the stable
`agentId` tuple (`sourceKind:sourceInstanceId:name`). Raw conversation/run logs stay
transcript-shaped as internal evidence; the memory line is a separate store. No
migration — wipe dev data.

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

**BUILD** — the memory line: `agents/<agentId>/memory/` store + profile UI
(view/edit/forget) + reminder-stack injection; clean-cut remove the
model-visible inline memory writer and model-visible `past_chats`; expose a
single read-only `recall` tool whose evidence is nested under memory results;
then add Dream/extraction and consolidation as the only automatic writers. **The task
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

**CLEAN-CUT (post-#167) — "subagent" is no longer an agent *type*.** After
[[agent-authoring]] (#167) unified the fresh-subagent system prompt onto the shared
core, the only thing separating "the agent" from "a subagent" is *which task it
runs*, not *what kind of thing it is*. Three now-redundant artifacts fall out and
are removed as terminology/redundancy cleanup (M1/M2) — **not** the §3 main-agent
registry refactor, which stays P3:

- **Retire `general`.** Post-#167 `createGeneralAgentDefinition` is an empty-body
  built-in (`agentSubagents.ts:1295`) — identical to "the primary identity run
  fresh." A `fresh` task with no explicit runner, the skill default, and the
  unknown-type fallback all resolve to the primary identity; `general` and the
  `general-purpose` alias are deleted (no back-compat).
- **`fork` is a context *mode*, not a pseudo-`AgentDefinition`.** Drop
  `createForkAgentDefinition` as a throwaway "definition" (it never belongs in a
  roster); a `fork` task is the caller's identity + prepared context + a fork
  directive (memory → caller, per `resolveSubagentMemoryOwner`).
- **Capability is profile-only.** Drop the `Agent` tool's per-call `model`/`effort`
  overrides (`agentSubagents.ts:635-636`); a runner's model/effort/tools/permission/
  `maxTurns` come from its profile — consistent with model moving onto the agent
  profile (§Agent).

Bounds (do not over-reach): honor **F2 no stored `kind`**; do **not** redesign the
protected owner-resolution / run-ledger-addressing seams (`agentDelegationIdentity.ts`;
the transcript codec was deleted by [[agent-run-unification]] — [[agent-program]] M3 note); "Task" keeps meaning the off-floor `background` run
([[agent-data-model]] `RunMeta.kind`), not "every `Agent` call"; the model-facing
rename is contract + UX only (storage names may stay); and any identity-string
change (e.g. retiring `general`'s `built-in:tenon:general` owner key) is a
dev-`userData` **wipe**, not a no-op rename. The broader standalone reframe that
proposed a stored `DM|Channel` kind, a storage-level rename, and redefining "Task"
was reviewed and **redirected** (archived `agent-task-model.md`); only this bounded
cleanup survives.

**Protocol-surface coordination (A4 / A7).** This plan's surface items — `actor` on
`AgentEventMessageRecord` (`src/core/agentEventLog.ts`), `forAgentId` derivation, the
`Principal` type + conversation `members` (with `cursors` as a separate per-principal
store) + `RunMeta` (no stored `kind`; `src/core/types.ts`) — are part of the
**consolidated M0 protocol-surface change list** in [[agent-program]] (which also
covers `SkillDefinition.source += 'built-in'`, the `user_question.*` / `widget_state`
events, etc. — the event taxonomy is decided there once). M1+ consumers must use the
target surface directly; do not preserve old session-shaped protocol branches.

## Phases (revised effort)

**Execution (complete-per-PR).** This is a large subsystem, so the plan is shape
(b): a **set of independent complete features**, each its own PR, dependency-
ordered — *not* one feature sliced across phases. The table is the roadmap; each
named capability (identity record, DM, Channels, memory foundation, memory v2 +
recall, task panel, notifications, multi-member routing) ships as a complete,
verifiable PR. Foundation/protocol seams (the identity tuple, the `actor` field)
land interface-first as their own infra PRs (the shared-surface carve-out), but no
*feature* PR ships a partial slice that only becomes useful in a later one.
**Landed:** M0/M0.5 seams + M1 spine and M2 background visibility (task panel +
notifications). **Remaining:** mid-run `needs-input` (deferred by decision) and the
M3 multi-member spine — each its own complete PR.

| Phase | Scope | Honest size |
|---|---|---|
| **P0** | Give the main agent a stable identity record — the `sourceKind:sourceInstanceId:name` **tuple** ([[agent-data-model]] §3), not a bare `name` — that memory keys off. **Not** the registry refactor. Pinning the full tuple here is what avoids the cross-project same-name memory collision (a bare `name` would reintroduce it). | small (incl. the tuple decision) |
| **P1** | **mixed-resolution assembly** in `deriveRuntimePiMessages` — join run logs for the recent window, render old segments as their (compaction) summaries; **canonical DM + user-creatable Channels** (conversation-list surface; DM find-or-create); **memory foundation** (runtime-owned event-sourced append surface — *not* `file_write`; **global-default + opt-in isolation** retrieval; profile UI; reminder-stack injection). DMs are one-agent relationships; Channels are named rooms whose invited agents can change over time. | memory storage/UI/recall + channel UX on top of M0/M0.5 |
| **P2** | **Memory v2 Dream + recall clean cut** — remove the main agent's model-visible inline memory tool and model-visible `past_chats`; add the single read-only `recall` tool over durable memory, with optional nested evidence expansion through `MemoryEntry.sources`; add a runtime-owned Dream/extraction writer that uses summaries/search only to locate candidate spans, then reads raw conversation/run evidence before add/update/forget; host callback + throttling + provenance tagging. | real build (~500–700 LoC) |
| **P3** | **Sequential multi-member Channels** — per-agent POV derivation + per-member `agentId` (on the P1 `actor` field), **coordinator-based turn-taking routing** (§Channel routing), rooms-are-linear; **the main-agent registry unification**; deeper memory consolidation. | the big subsystem |

Single-member conversations (DM + a Channel staffed with one agent) deliver most
of the value — per-agent memory, named Channels, no session — without any of the
multi-agent machinery.

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
  avoids the shared-state collisions (§2). **Superseded 2026-06-11 (PM):**
  concurrent co-addressee execution + completion-order delivery ratified as a
  pure execution-layer upgrade — the independence cut already makes replies
  order-free; the §2 collisions get repaid, not dodged
  (`agent-channel-parallel-runtime`).
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
  hazard), each agent got **opt-in isolation tiers** (`isolated` / `read-only-global`) over
  the global default, with `originWorkspace` recorded on every entry. **Revised 2026-06-10:
  the `isolated` tier was removed** — a pool is one undivided self-model, never
  workspace-partitioned; `read-only-global` (pause writes) remains and `originWorkspace`
  is provenance only. Inspect / edit / forget stays the backstop.
- **Memory internal format — DECIDED.** Structured event-sourced store, not
  markdown topic files. Memory is runtime-owned durable state, not an
  agent-writable file tree.
- **Per-turn memory injection budget.** Whole index vs top-N by recency/salience;
  bound it (cc-2.1 caps MEMORY.md at 200 lines / 25KB).
- **Memory write — DECIDED (PM-ratified 2026-06-05; revised 2026-06-06/07): runtime-owned
  append surface, not a privileged file path, and not a model-visible foreground-agent
  tool.** The earlier "permission-exempt `file_write`/`edit` into the memory store" is
  dropped — the file tools are realpath-jailed to `workspace.root`
  (`agentLocalTools.ts:2207`) and cannot reach `userData/agent/`, and whole-file
  rewrite + `fileWriteChains` serializes I/O but not logical *lost-update*. The
  2026-06-07 revision pins the final writer set to Settings/Profile UI and
  Dream/extraction only: no model-visible memory write tool and no direct
  foreground write path. Memory is written through a **runtime-owned, event-sourced append API**
  (`memory.entry_added/updated/removed` → projection) by those writers.
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

P1 — conversations + memory foundation
- [x] `session`→`{conversation, run}`: split the message stream (communication) from the run log (execution **incl. `tool_result`**); re-key `sessions/<id>` → `conversations/<id>` + `runs/<id>`; IPC, state map, scopes.
- [x] **Mixed-resolution assembly** (PM-ratified): `deriveRuntimePiMessages` joins the recent window's run logs into a valid pi-agent-core transcript and renders old segments as their (compaction) summaries — the agent no longer re-sees old tool outputs verbatim.
- [x] `Principal` type; `members` on the conversation record (`meta.json` = projection of membership events; `cursors` a **separate** per-principal store) — **no stored `kind`** (DM/Channel derived from canonical DM identity vs Channel-name presence; the current event field is still `goal`). `RunMeta` with mandatory `conversationId` anchor + `trigger` provenance.
- [x] Store `actor` on `AgentEventMessageRecord`; drop implicit `'pi-mono'` by parameterizing runtime-authored agent actors — foundation for task-notification attribution + P3 POV.
- [x] **Canonical DM + Channels** (PM-ratified): one find-or-create DM per agent (no "new conversation" for DMs); re-target the `createSession`/`deleteSession`/`renameSession` surface to **Channels**; Channel creation requires a name, while invited agents are optional and mutable.
- [x] Distillation backbone: make `compaction.completed` a multi-consumer node with an explicit both-ends `source` range (raw retained, already non-destructive). The later model-facing recall surface is a single `recall` tool; summary search and raw expansion stay internal implementation details.
- [ ] "Add agent" spawns a new seeded Channel (no in-place conversion); combined, provenance-marked message forwarding (any conversation → any conversation).
- [x] `agents/<agentId>/memory/events.jsonl` store (event-sourced) + a **runtime-owned memory-append surface** (append-only, schema-checked, serialized, audited — *not* `file_write`); retrieval over **one undivided pool** (`isolated` tier removed 2026-06-10; `read-only-global` = pause writes), `originWorkspace` recorded as provenance; `MemoryEntry` binds source `runId`/`eventId` for undo-invalidation.
- [x] Inline memory write instructions in the agent prompt shipped during the
  M1 foundation, but are no longer the target write architecture and should be
  removed cleanly before further memory consumers.
- [x] Memory recall added to the per-turn reminder stack (`agentRuntime.ts:640`); index budget bounded; `sources` down-pointer recorded (for the visible guard, not retrieval scoping).
- [x] Profile UI: view / edit / forget memory.
- [x] M0.5 clean cut: rename/remove remaining agent `session*` protocol/index/API
  bridge debt, then wipe dev userData (format change, no migration).

P2 — memory v2 + background-task surfacing
- [x] Remove the main agent's model-visible inline `memory` tool and prompt guidance; keep Settings/Profile UI and `<agent-memory>` consumption.
- [x] Remove the model-visible `past_chats` tool; replace it with the single
  read-only `recall` tool over durable memory. `include_evidence` defaults to
  false; when true, evidence is nested under each returned memory entry, respects
  `max_chars`, and expands raw logs only through `MemoryEntry.sources`.
- [x] Make the no-backfill consequence explicit in implementation notes and UI
  copy where relevant: old conversations without a `MemoryEntry` are not
  foreground-recallable by design.
- [x] Runtime-owned Dream reflective run with a restricted no-tools model
  surface and runtime host callback; scheduled `date` trigger plus manual
  `/dream`, no per-turn write-back.
- [x] Read raw conversation/run evidence since the Dream watermark before
  writing memory. Distillation summary/search remains a future locator
  optimization only.
- [x] Dedupe/conflict-check against existing visible memory; append
  add/update/forget events with raw provenance tags
  (conversation/message range/run/event/workspace). The automatic path is gated
  by a per-agent lock, provider availability, date due-ness, and minimum evidence
  volume; `/dream` bypasses only the volume heuristic.
- [x] First visible task-panel slice: current-conversation `subagent_run`
  projection records, open-details action, and stop action for running subagent
  tasks.
- [ ] Extend the task panel to per-agent cross-conversation aggregation and
  non-subagent task adapters (Dream/offline consolidation, scheduled routines,
  background shell tasks).
- [ ] Generalize `pendingSubagentNotifications` → conversation-scoped delivery (reusing the P1 `actor` field) + first-class task-update messages + rate-limiting/folding. (DM delivery; Channel/coordinator delivery is P3.)

P3 — sequential rooms + consolidation + registry
<!-- SHAPE NOTE (AGENTS.md "complete feature, no phased partial PRs"): the P3 block below
     (POV · turn-taking · coordinator routing · floor cache · floor-aware delivery) is the
     **M3 multi-agent spine** — these are interdependent build-order WITHIN one feature, not
     separate dev claims. #1208 in particular is un-demoable without #1204 (POV). Dispatch the
     spine as ONE complete multi-agent-Channel feature; do NOT hand out the rows individually.
     All of it is gated on the agent-data-model §4 principal/membership foundation (cc-2, PR #173). -->
- [ ] `forAgentId` POV derivation in `deriveRuntimePiMessages` (others' turns → user-role); thread per-member `agentId` into the P1 `actor` field (N-agent authorship).
- [ ] Sequential turn-taking routing; rooms-are-linear (no per-agent branch pointers).
- [ ] Channel routing: coordinator Member role flag (default = main agent); explicit `@` bypasses, no-`@` → coordinator, hop-budget-bounded relay; coordinator reassignable per channel.
- [ ] Promote the main agent through `AgentDefinitionRegistry` (the ~1–2k-LoC refactor). **P3, deferred** (§3: cost overstated ~10×).
- [ ] Long cache TTL + deterministic POV derivation for floor-switching (§Prompt cache impact).
- [ ] Floor-aware task delivery in Channels + `needs-input` wake (asyncRewake-style); keep background-run isolation from session singletons.
- [x] Offline consolidation pass (gated time + activity + lock). Shipped #163: scheduled
      reflective Dream with per-agent in-flight lock + online/due/min-evidence gates.
