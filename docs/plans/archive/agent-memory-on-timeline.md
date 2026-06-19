# Agent memory on the timeline

## Goal

Replace the agent's separate event-log memory subsystem with **memory as ordinary
outliner nodes on the daily timeline**, written and read through the existing
`node_*` tools and a re-provided `past_chats` tool, with consolidation ("dream")
expressed as an **editable skill** instead of hardcoded runtime logic.

Memory becomes legible and correctable in two senses:

- **Content** — you can see and edit *what* Neva remembers, in your own timeline,
  where you already look. Editing a memory node *is* correcting the memory.
- **Policy** — *how* Neva remembers (the consolidation playbook) is a skill
  document, not code; you (or Neva) tune it by editing markdown.

The end state has **no special memory subsystem**: memory is nodes + `node_*` +
search + skills/persona. The only memory-specific runtime is a thin trigger built on
the already-shipped scheduled-routines (§3).

## Scope — this is a reversal, not a "supersede"

State the magnitude honestly (it sets the A6 fold-into-spec budget): this does **not**
"supersede the relevant parts" of the memory docs — it **reverses a shipped,
PM-ratified subsystem and the data-model's founding axiom**.

- It **reverses `agent-data-model.md` §0–§2**: the hard axiom *"agent data … never
  touches Loro"* and the *"one log engine, three instances, memory = single writer
  per stream"* model. Moving the memory line into Loro **deliberately abandons
  memory's single-writer invariant** (Loro has two writers: user + agent) — which is
  exactly what makes memory user-editable. It is a conscious PM-owned reversal, and it
  has concurrency/undo consequences this plan now analyzes (§5).
- It **retires most of `agent-memory-foundations.md`'s working-memory / activation /
  retrieval-mode content** (the passive-briefing/chronic-activation machinery).
- It **keeps the spine**: auditability (a source dereferences to original bytes or
  fails loud) and the episodic→semantic consolidation ladder.

The A6 step is therefore a **rewrite** of those spec sections, not a patch — budget it.

**New nouns/protocol introduced here (kept visible per the repo "shipped-concepts"
rule):** the `d-memory`/`d-episode`/`d-belief` tag family, and **one new
`ReferenceTarget` variant** (`chat-source`) carrying a cross-boundary source pointer
inline. That is the *entire* protocol delta on the infra-ownership surface — see §2
for why source becomes an inline reference rather than a new `NodeBase` field, and §8
for why the dream watermark and node access-stats stay **side stores** (off Loro), not
node fields. The shipped concepts this builds beside are `tag:day` / `[[node:…]]` /
`[[file:…]]` references / `capture` / `command` / `origin:'agent'`.

## Shape

A **SET of independent, complete features**, ordered by dependency:

- **PR1 — Re-provide the `past_chats` agent tool.** Independently complete and
  valuable (Neva can read/search/verify raw past conversations again). Foundation
  for everything below (A7).
- **PR2 — Node-based memory.** The atomic core flip: node structure + dream-as-skill
  + the scheduled-routines trigger + pull-only recall, replacing the event-log memory
  store, the activation/decay engine, the passive briefing, and the `recall`/`dream`
  tools. Pre-release, no migration — old memory is wiped, not converted.
- **PR3 — Jump-to-source UI.** Additive on top of PR2, but **not a one-line addition**:
  render the inline `chat-source` ref as a clickable chip that opens the conversation
  transcript at that position. The renderer's inline-ref click route is hardcoded to
  node ids today (`RichTextEditor.tsx:529-541` reads `data-inline-ref` → a `nodeId` and
  calls `onInlineReferenceClick(nodeId)`), so this is a handful of coordinated edits — a
  `kind` marker on the chip DOM, a click branch, a target-typed callback, and the
  transcript-jump consumer — not a pure append.

PR1 and PR3 are each shippable and reviewable alone; PR2 is the one large,
genuinely-atomic change (memory cannot be half-migrated pre-release — read and write
must flip together; the obvious "land node structure first, fill later" split is the
forbidden scaffold-then-fill).

**Ordering dependency — satisfied.** PR2 presupposes `single-agent-finish-collapse`,
which **shipped as #300** (merge `4374928a`, gate `c56f1a46`). PR2 now *inherits*
rather than performs that work: `principal` is a runtime-constant one-Neva pool, and
the cross-principal redaction (`memoryEntryVisibleToReader` cross branch +
`crossPrincipalEvidenceRefusal`) is **already removed**. No remaining ordering gate;
PR2 builds on post-#300 `main`.

## Background — pre-PR2 baseline (post-#300 `main`, `c56f1a46`)

- **Memory store.** A separate append-only event log per principal
  (`principals/<principal>/memory/events.jsonl`) in `src/main/agentEventStore.ts`
  (`memoryPaths` ~`:407`, `addMemoryEntry(principal,…)` ~`:783`), **not** in the Loro
  document. Post-#300 the principal is a **runtime-constant one-Neva pool**. Shapes
  (`src/core/agentEventLog.ts`): `AgentMemoryEntry` (semantic) + `AgentMemoryEpisode`
  (episodic), each with `sources[]` of `AgentMemorySource {stream, streamId, range}`.
- **Dream.** Runtime code (`src/main/agentDreamExtraction.ts` + `agentRuntime.ts`
  ~`:670/765/3064`) reads conversation/run logs past a per-pool
  `AgentDreamWatermark {conversations, runs}` (`agentEventLog.ts:499`), builds an
  extraction prompt, applies add/update/forget. Fired by the `dream` self-maintenance
  tool (`agentSelfMaintenanceTools.ts:126`) + an autonomous daily-cadence scheduler +
  backoff (`dreamBackoff.ts`). No `/dream` slash command.
- **Recall + briefing (removed by PR1/PR2).** `recall` was a tool doing BM25 + a three-component
  activation/decay model + source-association ranking
  (`src/core/agentMemoryRetrieval.ts`, `src/core/agentMemoryActivation.ts`). The
  activation engine ranked **both** the briefing **and** recall
  (`compareHybridRankedEntries`). PR1 restored raw pull access as `past_chats`;
  PR2 removes resident briefing injection.
- **`AgentPastChatsService`** (`src/main/agentPastChats.ts:188`): `search` / `recent` /
  `read` / `readMemorySourceEvidence`; only the last is wired (into `recall`'s evidence
  expansion). A `past_chats` *tool* existed (`11a5b680`), removed in `1a04f6ce`; engine
  intact.
- **Node search is BM25-ranked (verified).** `node_search` (`agentNodeTools.ts:969`) →
  `agentNodeToolSearch.ts:253` → `searchEngine.ts:271` `sortSearchHits`, scores from
  `textSearchIndex.ts:256`. Default sort is by score; an explicit `sys:createdAt/
  updatedAt` rule overrides. So "recall = content search" holds — but it returns
  *relevance* order only, with **no recency/access decay** (that lived in the
  activation engine being removed — see §4).
- **Document node model.** Date nodes are plain `ContentNode`s tagged `tag:day`;
  `todayId` is dynamic. `capture` is a **specific typed field** `capture?:
  CaptureNodeMetadata` on `NodeBase` (`types.ts:384`), *not* an open sidecar channel.
  Agent mutations go through `origin:'agent'` commands and a **serial mutation queue**
  (`documentService.ts`). Undo is **origin-scoped**: `userUndoManager` excludes
  `'agent:'`, `aiUndoManager` excludes `'user:'` (`loroDocument.ts:31-33,154-156`); the
  `undo` command derives its scope from `meta.origin` (`documentService.ts:651`). The
  renderer only draws **real Loro nodes**; a `reference` node targets a `NodeId`
  (in-document only).

## Design

### 1. Storage — memory is nodes on the timeline

```
2026-06-18  (day node, tag:day)
  ├ [the user's own notes for the day …]
  └ d-memory  (per-day memory container; recognition marker)
      ├ d-episode: "时间线做记忆的设计讨论"   (gist + inline chat-source ref)
      │   └ d-belief: "memory is pull-only; no passive briefing"
      ├ d-episode: "composer chip review 修复"
      │   └ d-belief: "the user prefers terse reviews"
      └ d-episode: …
```

**Naming.** Tags are named for *what a node is*, not who made it or how, and are
honest about epistemics. The `d-` prefix namespaces the family (collision-avoidance +
a visible group marker). **These are net-new product nouns**:

| tag | what it is |
|---|---|
| **`d-memory`** | the per-day memory container: the day's memory home and the recognition marker. (It carries no machinery — the dream watermark stays a side store, §8.) |
| **`d-episode`** | an episodic unit — a *topical segment* of a conversation (one session that covers many topics yields many episodes); holds a gist + an inline chat-source ref. |
| **`d-belief`** | a semantic unit — durable knowledge. Named `belief` (not `fact`) on purpose: it is what Neva holds true and **may be wrong**; "fact" would overclaim truth. |

(`dream` names the *process / skill*, never a node. "Who made it" is provenance —
`origin:'agent'` — not the tag.)

- **Episodes** live under the day they happened; episodic memory is time-anchored and
  the timeline is its natural index.
- **Beliefs** are born under the episode that produced them (provenance is partly
  structural: the parent episode is the evidence). A belief has a **single mutable
  identity**: it is **updated in place**, never tombstoned; other days/episodes that
  touch it again **reference** the same node. Beliefs are **timeless**. A reference
  always resolves to the belief's current state.
- **Belief change-history.** Each meaningful change **appends a change-history entry**
  (a body annotation or child node) recording *what changed and why* — and, for
  dream-driven changes, the new inline source ref (§2). This keeps the node a single
  evolving identity *and* preserves fact-level history on the node (you can see "Neva
  learned X from conversation A, then the user corrected it to Y"). Lightweight: an
  unchanged belief has no history.
- **Why single-day anchoring is no longer an anti-pattern.** Retrieval is content
  search (§4), which ignores physical location.
- **Recognition + status.** Memory nodes are recognized by the `d-` family. Active-vs-
  superseded is a **node state** (strikethrough / archive), not a kind tag. Nodes are
  real, user-editable, `locked` + `origin:'agent'`.

### 2. Provenance — source as an inline `chat-source` reference (one new ReferenceTarget variant)

The one invariant carried over: **memory is for an unreliable rememberer, so it must
be auditable — a source dereferences to the original bytes or fails loud.**

Conversations stay in the event-log (they are **not** nodes), so a normal `[[node:…]]`
reference (which targets a `NodeId`) cannot point at them. Rather than a new typed
field on `NodeBase`, the source rides the **existing inline-reference system**:
`ReferenceTarget` (`types.ts:200`) is already a discriminated union (`node` +
`local-file`), inline refs already persist in `RichText.inlineRefs[]`, render as chips,
and dispatch their click by `target.kind`. The source becomes **a third variant** —
`{ kind: 'chat-source'; stream; streamId; range }` — and the entire protocol delta is
that one union member (parser branch + click route + write-time validation). `capture`
is a specific typed field, not an open channel, so the typed-field route was rejected:
it would invent a new `NodeBase` field + projection + command; the inline route reuses
shipped machinery and puts provenance *in the prose where the claim is*.

(Only the **stream** source needs inlining: `AgentMemorySource`'s other arm,
`{episodeId}`, is moot here — in the node world an episode *is* a `d-episode` node, so
citing one is an ordinary `[[node:…]]` ref.)

**The trade (PM-owned, not "strictly better").** An inline ref is *more* exposed than a
hidden typed field: a user editing belief prose can delete the chip and the belief loses
its provenance — a typed field would survive a text edit. We accept this on purpose: the
whole thesis is that memory is user-editable and an edit *is* a correction, so a user who
removes a citation is exercising the same authority as one who rewrites the belief. The
mitigation is the §1 change-history (the prior ref stays bound to its history entry, so
deletion is visible/recoverable), not field opacity. This is a posture, not a claim that
inline dominates typed on every axis.

**Wire format (ratified).** Reuses the `[[<prefix>:<label>^<value>]]` grammar
(`referenceMarkup.ts`), prefix `chat`:

```
[[chat:<label>^<stream>:<streamId>@<from>-<through>]]
[[chat:<label>^<stream>:<streamId>@<from>-<through>:<eventId>]]    // with tamper-check
```

- `<stream>` = literal `conversation` | `run`; `@<from>-<through>` are decimal seqs
  (`fromSeqExclusive`-exclusive .. `throughSeq`-inclusive); `:<eventId>` optional
  (`throughEventId`, omitted when null). Excluded from BM25 scoring like other markers.

**Parse sub-grammar (settled now — it IS the protocol, not an M0 detail).** The existing
`parseReferenceInner` (`referenceMarkup.ts:245`) treats the post-`^` value as **one
opaque blob** and `decodeURIComponent`s the whole thing (`node`/`file` never re-parse).
The structured `chat:` value cannot ride that path — a single whole-value decode would
turn an encoded `%40`/`%3A` back into `@`/`:` *before* splitting and corrupt the parse.
So `chat:` gets a **dedicated branch** that splits on the literal structural delimiters
*first*, then `decodeURIComponent`s each segment:
  1. `stream` = up to the first `:`.
  2. `streamId` = from there to the `@` (then decoded).
  3. `from` / `through` = the decimal pair after `@`, split on the single `-`.
  4. `eventId` = the optional segment after the `:` that follows `through` (then decoded).
- **Disambiguation is structural, not encoding.** `@` (and the trailing `:`) separate the
  fields; `from`/`through` are digits-only, so the range `-` can never be confused with a
  hyphen elsewhere. Encoding the `streamId`/`eventId` segments only escapes a literal
  `@`/`:`/`^`/`]` that might appear *inside* them — it does **not** touch hyphens
  (`encodeURIComponent` leaves `-` as-is), so it plays no role in the range `-`. (The
  earlier "encode to avoid hyphen collision" rationale was wrong; today's ULID/uuid
  stream ids contain neither `@` nor `:`, so the encoding is belt-and-suspenders.)
- The outer `REFERENCE_PATTERN` / splitter are untouched; only `parseReferenceInner`
  opens the `chat` prefix and `ReferenceTarget` gains the variant.

**Accumulate, never clear.** A belief that is reinforced or changed gets the new source
**appended** as another inline ref (a belief may cite several); old refs stay, bound to
their change-history entry (§1), so each ref describes *what it supported at that time*
and never claims to support the current text — dissolving the
"resolves-but-no-longer-matches" hazard. A **user hand-edit** appends a `user-edited`
change entry (no machine source), keeping the trail append-only. A belief **inherits
its parent episode's ref** at birth and accumulates its own.

**Authoring is validated, not free-typed (the guardrail).** A fabricated citation is
worse than none, so chat-source refs are **validated on write**, mirroring how
`validateReferenceTargetIds` (`agentNodeToolSearch.ts:278`) rejects node refs to
non-existent ids: the runtime resolves the pointer against the event-log at write time
(stream/streamId/seq must exist; if `eventId` is present it must match the event at
`throughSeq`) and **rejects/strips** a ref that does not resolve. This structurally
prevents the model from inventing a working citation. Two distinct failure modes,
both kept:
- **rejected-at-write** — never resolved (fabricated). New guard.
- **fail-loud-at-read** — resolved once, later compacted / self-cleaned / user-deleted
  → "evidence unavailable," never a crash (existing behavior).

**Follow paths.** Agent: `past_chats.read(source)` returns the original text (same
dereference as today's `readMemorySourceEvidence`). User: the renderer draws the chip
as a "↗ source" affordance → the conversation transcript at the seq (PR3).

**This generalizes beyond dream.** Because authoring is just emitting an inline ref,
*any* node the agent writes from a conversation can carry a verifiable backlink — not
only dream output. The dream skill is simply the scheduled instance: it reads via
`past_chats`, which hands back the coordinates (§6), so its refs are valid by
construction. Ad-hoc daily citation works the same way for any chat the agent **has
read via `past_chats`** (coordinates in hand). Citing the *live current turn* is **not**
supported in v1 (the model never sees its own seq cursors; it would need a dedicated
"citation handle for here" affordance) — see Non-goals.

### 3. Writing — dream as a skill on the scheduled-routines trigger

A "runtime fires a smart thing on a trigger" decomposes into three layers; only the
bottom is skill-able:

| layer | what | home |
|---|---|---|
| **Trigger (when)** | schedule + durable cursor, at-most-once, backoff, the bright line | runtime |
| **Mechanism (how it moves)** | windowing, the persistent format contract, transaction | runtime |
| **Policy (the judgment)** | what to extract / keep / how to phrase | skill |

- **Reuse the scheduled-routines *shell*; build the memory handoff (net-new).** Dream
  becomes a scheduled-routine command node (`docs/plans/archive/agent-scheduled-routines.md`:
  anacron + at-most-once + backoff + agent-barred fire). Post-#300, `runCommandChildAgent`
  always forks Neva — exactly the one-Neva fork wanted. **But the memory-specific handoff
  does NOT exist yet:** the shipped fire passes only
  `buildTriggeredCommandPrompt(brief, lastSuccessAt)` — a natural-language time hint —
  and tracks `sysLastRunAt`, a **timestamp** fire-watermark (`types.ts:497`), *not* the
  per-stream **seq** cursors dream needs. PR2 must add (M2): (a) a `since:{seq}` range
  computed from a memory watermark and passed into the dream skill, and (b) advancing
  that seq watermark after a successful pass. The watermark stays a **side store** —
  per-pool seq cursors off Loro, exactly like today's `AgentDreamWatermark`
  (`agentEventLog.ts:499`) — *not* a node field: it is runtime bookkeeping the user
  neither edits nor needs to see, and the §3 layer table already puts the cursor in the
  runtime. Specified as new plumbing on the scheduled-routines layer, not asserted as
  existing.
- **Dream skill (markdown playbook).** Owns *how*: read the `since:{seq}` range via
  `past_chats` → segment each conversation into topical episodes → write `d-episode`
  nodes (gist + source) → extract beliefs; **search existing `d-belief` nodes first**
  and update in place, else create under the episode. The runtime advances the
  watermark after success; the model never manages the cursor.

### 4. Reading — pull-only (a PM-owned experience trade), taught by persona

- **No passive briefing.** Memory enters context only when the agent fetches it.
- **The full loss is larger than the injection.** The activation/decay engine ranks
  *both* briefing *and* recall (`compareHybridRankedEntries`). Deleting it means
  pull-only recall via `node_search` returns **relevance order only — no recency or
  access-frequency decay**. So we lose not just the passive push but "what I used most
  recently / most often surfaces first."
- **Recency/access decay is recoverable — generically, in a sibling plan.** Rather
  than re-implement memory-specific ranking, the `node-search-access-ranking` plan adds
  a per-node access-stats side store + a decay multiplier into `sortSearchHits`
  (`searchEngine.ts:271`) for **all** node search. The two plans are independent: memory
  ships pull-only-relevance-only now; when that plan lands, memory-on-nodes **inherits
  the decay for free**. (What it does *not* recover is memory's **source-association**
  ranking — that needs the §2 source refs and stays out of scope here.)
- **Caveat on "for free."** That sibling plan's access signal is **human open/focus**.
  Agent recall is a *pull* `node_search`, which does not open/focus a node, so an agent-
  recalled belief is **not** strengthened by the recall unless the sibling plan also
  records a (low-weight) agent-recall signal. So "inherits for free" holds cleanly for
  **human-touched** memory nodes; agent-only reinforcement is an explicit dependency on
  `node-search-access-ranking` carrying an agent signal (flagged there).
- **A deliberate, PM-owned experience regression, not a free simplification:** a fresh
  conversation opens **cold** (knowing nothing until the agent searches), trading a
  deterministic injection for a behavioral bet + a tool round-trip at task start. No
  recent-episodes backstop in this version.
- **Recall = search.** `node_*` over the `d-` family (BM25-ranked text; verified),
  plus `past_chats` for raw chats. Taught by **standing persona instructions** — not an
  invokable skill (using memory must be habitual; gating it behind a skill to load is
  circular).
- **Compensation:** memory is visible on the timeline, so the user can see/point at it.

### 5. Concurrency, undo & attribution (the cost of abandoning single-writer)

Moving memory into Loro makes the user and the agent two writers on the same nodes.
What that does and does not break:

- **Physical writes are serialized** by the `documentService` mutation queue, so there
  is no torn write. The **residual risk is a logical race**: dream's update-in-place of
  a `d-belief` interleaving with a user hand-edit of the *same* node's text — Loro's
  text CRDT merges at character granularity and can produce a garbled belief mid-rewrite.
  De-risk (M2): dream re-reads a belief immediately before writing and writes it as a
  **whole-node replacement** (not a character patch); the change-history (§1) makes any
  bad merge inspectable/recoverable.
- **Undo is already isolated by origin scope.** `userUndoManager` excludes `'agent:'`
  and `aiUndoManager` excludes `'user:'`; the `undo` command derives scope from
  `meta.origin`. So a user Cmd-Z routes to the user scope and **does not revert an agent
  consolidation** (nor vice-versa) — this mode is handled by existing machinery, not
  unanalyzed. PR2 only confirms the renderer's Cmd-Z carries `origin:'user'` (it does)
  and that agent memory writes carry `origin:'agent'`.
- **Attribution** stays clean via `origin:'agent'` + `locked`; a user unlock-and-edit
  becomes a `user-edited` change entry (§2).

### 6. The `past_chats` tool (re-provided)

- Re-expose `AgentPastChatsService` as an agent tool: `recent`, `search`, `read`, with
  a `since:{seq}` parameter, reusing `readMemorySourceEvidence` for the dereference.
- **Results must surface the coordinates** (`stream` / `streamId` / `seq` /
  `eventId`) of what they return — otherwise the agent has nothing to put in a §2
  `chat-source` ref. This is the small contract addition that makes inline citation (and
  the validate-on-write guard) possible: the agent cites only what it read here.
- Serves the **dream skill** (raw material), **interactive recall** (raw chats, not
  just distilled beliefs), and **provenance verification** (§2). Ships first.

### 7. Dedup — tag enumeration + agent judgment, not a fixed key

No fixed identity key. A content-hash key cannot dedup rewordings, and semantic dedup
is inherently model judgment. The `d-belief` tag **enumerates** all beliefs (node id is
the identity); the dream skill **decides update-vs-create** by judgment. The backstop
against proliferation is not a key but (a) good retrieval (BM25 `node_search` lets the
skill *find* the belief to update) + (b) a "search-before-create" discipline. Residual
drift is an accepted, watched cost.

### 8. Protocol surface touched (stated once)

Memory mostly reuses `node_*`. The **only** net-new protocol on the infra-ownership
surface (`src/core/types.ts`) is **one `ReferenceTarget` variant** — `chat-source`
(§2), with its `referenceMarkup.ts` parse/format branch, renderer click route, and
write-time validation. It lands **interface-first** (M0), per A4.

Deliberately kept **off** Loro / off `NodeBase`, as **side stores** (per-user runtime
state, not collaborative document content — putting them in Loro would bloat the CRDT
and create churn/conflict):
- the **dream seq watermark** (§3), exactly as today's `AgentDreamWatermark`;
- any **node access-stats** for recency/access ranking — but that is a *separate*
  plan (`node-search-access-ranking`), not this one; see §4.

The `d-memory`/`d-episode`/`d-belief` family is **tags + location**, not a new node
`type` or field — no protocol change.

## The seam test (so we don't over-generalize "make X a skill")

The criterion is not "does it have a trigger" (everything does) — it is: *is this a
judgment the user would want to read and edit, AND can it tolerate being one forked
agent run (offline, recoverable, not bootstrapping its own substrate)?*

- **Skill-able:** dream, periodic review, triage, import, research.
- **Kernel (never a skill):** compaction, tool-result trimming, context budgeting, the
  scheduler itself, single-writer, the permission floor. Compaction is *substrate the
  agent runs on* (a skill is itself an agent run — you cannot implement the floor with
  something that runs on the floor), is hot-path, and carries a strict persistent
  format contract.
- **Hybrid:** compaction's *retention policy* is already a prompt (`/compact` takes
  custom instructions) — editable policy is fine; making the *operation* a skill is not.

## Non-goals

- **No bi-temporal validity.** Beliefs are timeless and update in place.
- **No passive briefing.** Memory is pull-only (§4). (The memory-specific activation
  engine is removed; access-decay returns *generically* via the sibling
  `node-search-access-ranking` plan, not as memory machinery here.)
- **No citing the live current turn.** Chat-source refs cite only what the agent has
  read via `past_chats`; the model never sees its own seq cursors, so "cite here" would
  need a dedicated affordance — deferred (§2).
- **No migration / back-compat.** Pre-release: wipe `~/.lin-outliner-*` dev memory.
- **Conversations are not moved into the document.** They stay in the event-log; the
  link is the inline `chat-source` ref of §2.
- **No agent-private vs user pool split.** Collapsed to one pool by #300; not revived.
- **No new node `type` discriminant or `NodeBase` field.** Memory is `d-` tags +
  location + one inline-reference variant (§2, §8).

## PM-owned postures (ratified)

- **Pull-only is an intentional experience regression** (cold-start + loss of
  recency/access ranking), accepted (§4).
- **Memory now lives in the exportable user document** — no longer an isolated
  substrate; it rides along on any export / backup / future sync. Accepted for a local
  single-user app; stated plainly.
- **Single-writer is deliberately abandoned** for memory; the concurrency/undo
  consequences are analyzed and de-risked in §5.

## Deferred to PR2 (implementation details; design is settled)

- Recognition query: a `d-` prefix/namespace query vs a shared base tag.
- The exact shape of belief change-history entries (body annotation vs child nodes).
- Chat-source chip rendering + the validate-on-write resolver branch (implementation;
  the wire format and union variant are settled in §2).

## Build order (within PR2) — independently-verifiable milestones, each green first

Foundation before consumers (A7); each milestone ships with tests and is green before
the next; the protocol-surface fields land **interface-first**.

- [ ] **M0 (interface-first protocol):** add the `chat-source` `ReferenceTarget`
      variant on `src/core/types.ts` + its `referenceMarkup.ts` parse/format branch +
      the write-time validation hook, coordinated ahead of consumers. (The dream
      watermark is a side store — no Loro/`NodeBase` change.)
- [ ] **M1:** the node structure — `d-memory` / `d-episode` / `d-belief` recognition,
      inline chat-source refs, change-history entries. (Tests: shape + recognition +
      chat-source round-trip + a fabricated ref is rejected on write.)
- [ ] **M2:** the scheduled-routines → dream handoff (compute `since:{seq}` from the
      watermark, pass into the dream skill, advance the watermark after success) +
      the dream skill writing nodes (segment → `d-episode` → `d-belief`, search-before-
      create, whole-node replacement per §5). (Tests: a pass produces the expected tree
      + advances the watermark; a concurrent user-edit does not corrupt a belief.)
- [ ] **M3:** recall is pull-only over the nodes (persona guidance; remove briefing).
      (Tests: recall returns BM25-ranked beliefs; no passive injection occurs.)
- [ ] **M4:** remove the event-log memory pool, activation/decay engine, and
      `recall`/`dream` tools. (Tests: old paths gone; no dangling references.)
- [ ] **M5:** fold the shipped design into `docs/spec/` (A6) — a rewrite of the
      reversed sections of `agent-memory-foundations.md` / `agent-data-model.md`.
