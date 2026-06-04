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

## Non-goals (MVP)

- Breadth beyond a **Tana** reference adapter. Roam/Obsidian/OPML adapters come
  after the loop is proven. (The Tana adapter DOES implement all fidelity tiers —
  that is the user-facing point of this plan, not a follow-up.)
- Service/API import (OAuth) — orthogonal; see `agent-oauth-providers.md`.
- A dedicated import UI panel. MVP fine-tuning is conversational (pairs with
  `agent-ask-user-question-tool.md`).
- No change to the core command protocol (`src/core/commands.ts`).

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
  libraryForest: CreateNodeTree[]          // non-dated content
  dayBuckets: { y, m, d, children: CreateNodeTree[] }[]  // date-aligned content
  tagDefs?:   { id, name, color? }[]        // emitted at Medium/Full
  fieldDefs?: { id, name, type, options? }[] // emitted at Full
  // per-node tags / field entries ride on the tree nodes (extended node shape)
  stats: { nodes, code, days, tags, fields, droppedEmpty, dateRange }
  warnings: string[]
}
```

`options = { fidelity: 'full'|'medium'|'content', dimensions?: { tags, fields,
dateAlign, inlineRefs }, sections? }` — see "Fidelity is the user's choice".
`CreateNodeTree` already exists (`src/core/types.ts:563`) and covers content+code;
the higher tiers extend the per-node shape with `tags`/`fieldEntries`. Seed the
Tana adapter from `tmp/tana-import/import-tana.ts` (content tier — HTML/entity
cleaning, inline-ref handling, journal→day buckets) and layer the metanode/tuple
decoding for the tag/field tiers.

### 2. `import_apply` agent tool (the keystone)

An agent bash script runs in its own Core and **cannot mutate the live document**
— it can only emit a `NormalizedImport` JSON. `import_apply` is the bridge:

- Input: a `NormalizedImport` (inline or a path the adapter/agent wrote).
- Applies into a **staging container** `Library / Imports / <source>-<date>` via
  the EXISTING commands — `create_nodes_from_tree` (`src/core/core.ts:460`) for
  the forest, `create_tag`/`apply_tag` + `create_field_def`/field-entry commands
  for the tag/field tiers, and, on accept, `ensure_date_node`
  (`src/core/core.ts:1705`) for date-merge. No new protocol command needed.
- Wrapped in one undo group (operation journal) → one-click rollback.
- Returns stats for the agent to show the user.
- A follow-up `accept` action moves staged content to final targets: day buckets
  → native date nodes (date-aligned), the rest → user-chosen parents.

Lives alongside the other node tools (`src/main/agentTools.ts:188`,
`src/main/agentNodeTools.ts`); permissioned through `agentPermissions.ts`
(default **ask** on bulk apply).

### 3. Playbook `SKILL.md`

A methodology skill (`docs/spec/agent-skills.md` format) teaching the loop:
detect-format → (known? run adapter : probe + converse + author parser) →
preview → fine-tune → `import_apply` to staging → user accepts. Frontmatter:
`allowed-tools: [file_read, file_glob, file_grep, bash, file_write, file_edit,
node_search, import_apply, ask_user_question]`; `arguments` for source / file
path / fidelity / date-align. Codify a **sampling strategy** for large files
(never load whole — `jq`/`node` for top-level keys, type distribution, sampled
records) so `file_read` limits aren't hit.

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
(the dialog mechanism), `lazy-like-global-launcher.md` (a future UI entry point).
MVP touches new files + `src/main/agentTools.ts` + `docs/spec/agent-*`; it does
NOT touch `src/core/commands.ts`/`types.ts` protocol surface.

## Build checklist

- [ ] Define `NormalizedImport` + adapter contract incl. `options.fidelity`/
      `dimensions` (new `src/.../import/`).
- [ ] Tana adapter: port `tmp/tana-import/import-tana.ts` for the content tier and
      ADD `description` (currently dropped, 221 real nodes); then layer
      metanode/tuple decoding for tags + done-state (Medium) and fields (Full).
- [ ] `import_apply` tool: staging-write via `create_nodes_from_tree` (+ tag/field
      commands per tier); accept-mode date-merge via `ensure_date_node`; one undo
      group; stats out.
- [ ] Agent surfaces the fidelity choice (preset + per-dimension) at import time.
- [ ] Register + permission the tool (`agentTools.ts`, `agentPermissions.ts`).
- [ ] Author the playbook `SKILL.md` (loop + large-file sampling + tuning).
- [ ] Spec updates: `docs/spec/agent-tool-design.md` (import_apply),
      `docs/spec/agent-skills.md` (the import skill).
- [ ] E2E: a fixture Tana export → staging → accept → date nodes align.
