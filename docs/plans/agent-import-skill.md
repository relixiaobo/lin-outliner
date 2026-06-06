---
status: draft
owner: unassigned
created: 2026-06-04
---

# Agent Data-Import Skill

Give the in-app agent a first-class capability to import data from other products
(Tana / Roam / Obsidian / generic markdown) into the workspace, with user
fine-tuning — and, for formats we don't have an adapter for, let the agent
explore the export, talk to the user, and author a suitable parser on the fly.

## Goal

- Known formats import via bundled **deterministic adapters** (fast, correct at
  scale — 10MB / 36k-record exports).
- **Unknown formats**: the agent reproduces the human workflow Claude used to
  bootstrap the Tana importer — probe the file structure, converse with the user
  about intent (fidelity / date alignment / what to drop / where to place),
  author a transform script, run + preview stats, iterate, then write.
- **Safe landing**: imported content lands in a **staging container** first; the
  user reviews, then accepts to merge into targets. Date-bearing content aligns
  to Tenon's native date nodes on accept.
- **The user decides how much detail comes across** — fidelity is a first-class,
  user-controlled choice (preset tiers + per-dimension toggles), not a fixed MVP
  decision. See "Fidelity is the user's choice" below.
- A working ad-hoc parser can be saved as a new adapter (self-extending; see
  [[agent-self-modification]]).

M0/M1 dependency: build this on the target `ask_user_question` interaction
contract, skill audit events, and command/node mutation surfaces. Do not add a
temporary plain-turn fallback or importer-specific answer back-channel.

## Non-goals (MVP)

- Breadth beyond a **Tana** reference adapter. Roam/Obsidian/OPML adapters come
  after the loop is proven. (The Tana adapter DOES implement all fidelity tiers —
  that is the user-facing point of this plan, not a follow-up.)
- Service/API import (OAuth) — orthogonal; see `agent-oauth-providers.md`.
- A dedicated import UI panel. MVP fine-tuning is conversational through
  `agent-ask-user-question-tool.md`; this plan waits for that contract instead of
  adding a temporary plain-turn fallback.
- **Content tier** changes no core protocol. **Medium/Full** need a per-node
  id back-channel that does not exist today — this is a real, called-out decision
  in §2 ("the id-correlation problem"), not a free ride.

## Design

Three layers + one new agent tool.

### 0. Fidelity is the user's choice

How much of the source comes across is decided by the user, not baked in. Three
**preset tiers**, each overridable by **per-dimension toggles** so the user can
tune freely in conversation. The tiers and dimensions below are **validated
against the real `b8AyeCJNsefK@2026-03-01` export** (10,627-node import set):

| Tier | outline+text | description | code | date-align | tags | done/checkbox | inline-refs | fields |
|---|---|---|---|---|---|---|---|---|
| **Content** | ✓ | ✓ | ✓ | ✓ | — | — | flattened | — |
| **Medium** | ✓ | ✓ | ✓ | ✓ | → tagDef+apply_tag | → completedAt | → InlineRef | downgraded to text |
| **Full** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | → fieldDef+fieldEntry |

Measured usage in the real export (drives which dimensions are worth a toggle):
**tags 1,488 nodes** (card/highlight/task/article/prompt/product/model…),
**fields 646 nodes / 1,059 instances** (Source/Status/prices/Context Window…),
**description 221 nodes** (real body text — maps to Tenon `description`; the
current `tmp/tana-import` run DROPS these — fix), **done/checkbox 157 nodes**
(maps to `completedAt`), **inline-refs only 24** (minor — fold in, not a headline
toggle), images 5 / urls 16 (negligible — handled quietly, not user dimensions).
`description` is text, not structure, so it rides with content at every tier.
Interaction: day/week supertags (134+35) overlap `date-align` — at the tag tiers
do NOT re-apply them as user tags (native date nodes already carry day/week).

The agent surfaces the tier at import time (default **ask**, via
`agent-ask-user-question-tool.md`) — "how much detail?" — then lets the user
adjust any single dimension ("keep tags but not fields", "don't align dates").
Tier + toggles are just `options` passed to the adapter; the adapter emits only
what the chosen fidelity asks for. Tana's metanode/tuple/tagDef/attrDef decoding
(already reverse-engineered in the nodex reference) powers the higher tiers;
content+description is an extension of the proven `tmp/tana-import` path.

### 1. Adapter library (deterministic parsers)

Each adapter exposes one pure function:

```
parse(exportPath, options) -> NormalizedImport {
  libraryForest: ImportNode[]              // non-dated content
  dayBuckets: { y, m, d, children: ImportNode[] }[]  // date-aligned content
  tagDefs?:   { srcId, name, color? }[]        // emitted at Medium/Full
  fieldDefs?: { srcId, name, type, options? }[] // emitted at Full
  stats: { nodes, code, desc, days, tags, fields, droppedEmpty, dateRange }
  warnings: string[]
}
```

`NormalizedImport` and `ImportNode` are the **adapter's own internal types**, NOT
`CreateNodeTree` / a `src/core/types.ts` change. `ImportNode` is a superset —
`{ content, children, type?, codeLanguage?, description?, tags?: srcId[],
fieldEntries?: {...} }` — because `CreateNodeTree` (`types.ts:563`) carries only
`content / children / type? / codeLanguage?` and has nowhere to hang
tags/fields/description. The Content slice of `ImportNode` is exactly
`CreateNodeTree`; the extra fields are consumed by `import_apply` (§2), not by
`create_nodes_from_tree`.

`options = { fidelity: 'full'|'medium'|'content', dimensions?: { tags, fields,
dateAlign, inlineRefs, doneState }, sections? }`. Seed the Tana adapter from
`tmp/tana-import/import-tana.ts` (content tier + description — HTML/entity
cleaning, inline-ref handling, journal→day buckets) and layer the metanode/tuple
decoding for the tag/field tiers. **Handoff:** that seed is gitignored and lives
only in the main clone — the building clone must copy it into its branch as the
Content-tier starting point (it does not travel with the repo).

### 2. `import_apply` agent tool (the keystone)

An agent bash script runs in its own Core and **cannot mutate the live document**
— it can only emit a `NormalizedImport` JSON. `import_apply` is the bridge:

- Input: a `NormalizedImport` (inline or a path the adapter/agent wrote).
- Applies into a **staging container** `Library / Imports / <source>-<date>`; on
  accept, day buckets merge into native date nodes via `ensure_date_node`
  (`src/core/core.ts:1705`) and the rest moves to user-chosen parents.
- Wrapped in one undo group (operation journal) → one-click rollback; returns
  stats for the agent to show the user.

#### The id-correlation problem (resolve before ratify)

The **Content** tier is genuinely zero-protocol: `create_nodes_from_tree`
(`core.ts:460`) builds the forest in one transaction. **Medium/Full** must attach
tags / field-entries / done-state **per source node**, which needs an
input-position → created-`nodeId` map — and `create_nodes_from_tree` returns only
`CommandOutcome { projection, focus? }`, no such map. Design space:

- **A. Extend `create_nodes_from_tree`** to return the created-id tree → touches
  the `src/core/commands.ts` / `types.ts` **protocol surface** → coordinated,
  interface-first PR + PM ratification (A4/A7).
- **B. A dedicated `import_apply` *core* command** that builds the forest and
  applies tags/fields/done atomically, returning stats → also protocol surface →
  same interface-first + ratify path. Cleanest for an in-app *live* apply
  (atomic, one IPC round-trip, no renderer-side id juggling).
- **C. Position-recovery, no protocol change**: after the bulk tree write, read
  state once and pair source forest ↔ created children by position (order is
  exact because `create_nodes_from_tree` neither drops nor reorders;
  `applyChildTagsDirect` adds tags, not nodes), then call `apply_tag` /
  field-entry / done commands per recovered id.

**Recommendation:** ship MVP on **C** — it is already *proven and measured*: the
`tmp/tana-import` description back-fill IS option C (single post-write
`core.state()` read → position-match → 221 `update_node_description` calls), and
the whole 10,627-node import + back-fill runs in **~8s** headless. Promote to **B**
only if the in-app live-apply path or perf demands it; if so, treat B as a
coordinated protocol change (interface-first + ratify), do not slip it in. Either
way, **§Non-goals is now honest: Content = zero-protocol, Medium/Full = C (or a
ratified B).**

#### Perf & batching (A9 — measure before done)

Baseline measured headless on the real `b8AyeCJNsefK` set: ~8s for the full
content+date+description import (one transaction per `create_nodes_from_tree`
call). Risks to address in-app, not assume away: (1) a 10k-node apply as one undo
group is ~10k+ journal events in one operation — confirm the journal handles that
volume and the **accept** is one coherent undo step; (2) the in-app path adds IPC
+ the UI thread — batch by section/day, **report progress**, and **re-measure the
in-app apply on the real set before calling it done** (the ~8s is headless Core,
not the live renderer round-trip).

Lives alongside the other node tools (`src/main/agentTools.ts:188`,
`src/main/agentNodeTools.ts`); permissioned through `agentPermissions.ts`
(default **ask** on bulk apply).

### 3. Playbook `SKILL.md`

A methodology skill (`docs/spec/agent-skills.md` format) teaching the loop:
detect-format → (known? run adapter : probe + converse + author parser) →
preview → fine-tune → `import_apply` to staging → user accepts. Frontmatter:
`allowed-tools: [file_read, file_glob, file_grep, bash, file_write, file_edit,
node_search, import_apply]`; `arguments` for source / file path / fidelity /
date-align. Codify a **sampling strategy** for large files (never load whole —
`jq`/`node` for top-level keys, type distribution, sampled records) so
`file_read` limits aren't hit.

**Dependency order:** the fidelity "default ask" UX wants
`agent-ask-user-question-tool.md`, which **does not exist yet** (`grep
ask_user_question src/main/` is empty). So either this skill lands *after* that
tool, or it **degrades to plain conversational turns** (the agent asks in prose,
the user replies) — the skill must not list `ask_user_question` in
`allowed-tools` or assume it. Treat it as an enhancement, not a hard dependency.

### Safety

Staging-first (no dirty data in the main tree until accepted); bash / file_write
/ import_apply gated by allow/ask/deny; everything undoable.

## Open questions

- Where do bundled adapters ship — in-repo `.agents/skills/import/adapters/` vs
  the user `~/.agents/skills` dir? (Leaning in-repo so they version with the app.)
- Is "accept from staging → targets" a second `import_apply` mode, a separate
  tool, or a manual user action? (Leaning: a mode of `import_apply`.)
- Reliability bar for agent-authored parsers on unknown formats — acceptance is
  "user previews & accepts", but do we cap node count / require a dry-run first?
- Re-import / fidelity change: if a user re-imports the same export (e.g. at a
  higher tier), do we de-dup against a prior import or always stage fresh?
- Medium tier: what exactly "downgraded fields" become — a plain child line
  `name: value`, or the value as a child node under a label?

## Collision check (2026-06-04)

No overlap. Open PRs #92/#96 (OAuth), #97 (field-value rows) are unrelated.
Adjacent plans are complementary, not conflicting: [[agent-self-modification]]
(skill authoring — enables save-as-adapter), `agent-ask-user-question-tool.md`
(the dialog mechanism — soft dependency, see §2), `lazy-like-global-launcher.md`
(a future UI entry point). MVP touches new files + `src/main/agentTools.ts` +
`docs/spec/agent-*`. Protocol surface (`src/core/commands.ts`/`types.ts`): **not
touched if Medium/Full use option C** (recommended); if the build later chooses
option B, that becomes a coordinated, interface-first protocol change requiring
its own ratification — flag it then, do not bundle it here.

## Build checklist

- [ ] **Handoff:** building clone copies `tmp/tana-import/import-tana.ts` (already
      does content + date-align + 221 descriptions, measured ~8s) into its branch
      as the Content-tier seed — it is gitignored / main-clone-only.
- [ ] Define `NormalizedImport` / `ImportNode` (adapter-internal, NOT a `types.ts`
      change) + adapter contract incl. `options.fidelity`/`dimensions`.
- [ ] Tana adapter: content tier + `description` from the seed; then layer
      metanode/tuple decoding for tags + done-state (Medium) and fields (Full).
- [ ] Decide the id-correlation approach (§2): default **C** (position-recovery,
      no protocol change). Only if going **B**, raise a separate interface-first
      protocol PR + ratify first.
- [ ] `import_apply` tool: staging-write (forest + per-node tags/fields/done via
      the chosen approach); accept-mode date-merge via `ensure_date_node`; one undo
      group; **progress reporting**; stats out.
- [ ] Measure the in-app apply on the real `b8AyeCJNsefK` set (A9) before "done".
- [ ] Agent surfaces the fidelity choice (preset + per-dimension); degrade to
      conversational turns until `ask_user_question` exists.
- [ ] Register + permission the tool (`agentTools.ts`, `agentPermissions.ts`).
- [ ] Author the playbook `SKILL.md` (loop + large-file sampling + tuning).
- [ ] Spec updates: `docs/spec/agent-tool-design.md` (import_apply),
      `docs/spec/agent-skills.md` (the import skill).
- [ ] E2E: a fixture Tana export → staging → accept → date nodes align.
