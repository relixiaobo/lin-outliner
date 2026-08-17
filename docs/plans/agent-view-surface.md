# Agent View Surface

## Goal

The agent can **see**, **set**, and **configure** a node's view through the
existing outline tool surface — table today, cards/calendar and any future mode
later — so a request like "整理成表格放到文档中" produces a real table view over
field-structured records instead of ASCII art inside code blocks.

Evidence (2026-08-16, dev:main): asked to put OpenAI pricing "into a table in
the document", the agent wrote fourteen space-aligned text tables inside code
blocks and first asked whether to deliver DOCX or Markdown. It could not have
done better: the view system is invisible to it (see Current state).

## Non-goals

- Implementing cards/calendar rendering. Each future view is its own renderer
  plan; this plan only keeps the agent surface ready to admit them.
- Exposing pure-chrome toggles (`set_view_toolbar_visible`) — no agent value.
- Skill-routing fixes for personal skills that shadow "document" requests —
  outside this repository.
- Protocol changes. This plan consumes existing `src/core/commands.ts` commands
  only; no new command, no `types.ts` change.

## Current state

Core already has the full mechanism; the gap is entirely in the agent layer.

- **Core**: `ViewMode` is `list | table | cards | calendar` (`types.ts`). Each
  owner node keeps per-view config on an internal `viewDef` child. `setViewMode`
  (`core.ts`) works on **any** node and, on a real transition into table,
  materializes search results first and auto-appends missing display fields
  from the records' used fields (`entersTable`,
  `tableDisplayFieldInitialization` in `viewConfig.ts`; behavior spec:
  `docs/spec/ui-behavior.md` "Table View"). Sort/filter/group/columns all have
  commands: `add/update/remove/clear_sort_rule`, `add/update/remove/clear_filter_rule`,
  `set_group_field`, `add/update/remove_display_field`.
- **Renderer**: ships `list` and `table` (`ViewToolbar.tsx`); `cards` and
  `calendar` exist only as enum values today. An unknown stored mode renders as
  list.
- **Agent surface — three gaps**:
  1. *Cannot see.* `outlineNodeText` (`agentNodeToolRead.ts`) and `outlineText`
     (`context/userView.ts`) surface `%%view:<mode>%%` only for search nodes
     (via `searchViewModeOf`); an ordinary node in table view is
     indistinguishable from a list node. Internal view node types are excluded
     from the projection entirely.
  2. *Cannot set.* The outline parser accepts `%%view:<mode>%%` on any line
     (`removeViewDirectives`, `agentOutlineParser.ts`), but write paths persist
     it only for saved-search specs (`applySearchViewSpec`,
     `agentNodeTools.ts`); ordinary nodes get the warning "View directives are
     only persisted on search nodes today."
  3. *Was never told.* No model-facing text — `agentNodeToolGuidance.ts`,
     `agentNodeToolSchemas.ts`, `docs/spec/agent-tool-design.md` — mentions
     view modes, the directive, or the field→column relationship. The directive
     appears in zero documents under `docs/`.

## Design

### Principles

1. **One mode-agnostic directive.** `%%view:<mode>%%` on a directive-capable
   owner's line is the single read/write representation for every view mode. A
   future view adds a vocabulary entry, never new syntax. A complete edit
   outline without a directive means the effective default, `list`;
   code-block syntax preserves its current mode because it cannot carry the
   directive.
2. **Vocabulary from one source.** Agent-settable modes are the modes the
   renderer can render — a single exported constant (today `['list', 'table']`)
   the tool layer validates against. A core-known but unshipped mode
   (`cards`, `calendar`) fails with a stable `view_mode_not_available` error
   when newly requested; an edit may preserve an identical already-stored mode
   so an unrelated change is not blocked. An unknown string fails with
   `invalid_view_mode` naming the allowed set.
   Shipping a new view extends the constant and adds a guidance paragraph —
   nothing structural.
3. **View config is core-defined nodes; the agent reads/writes them as typed
   config lines.** Sort rules, filter rules, group field, and display fields
   already live under `viewDef` with dedicated commands. The agent surface
   serializes them in the same rule-line style as saved-search queries
   (`searchQueryOutlineLines` precedent) and patches them through the existing
   commands. A future view brings its config nodes with it (calendar → date
   field binding; cards → card fields) and slots into the same serialization,
   without new tools.
4. **Guidance teaches the task mapping, not just syntax.** Tabular data inside
   the document = records as children + `Field::` names as column identities +
   values as cells +
   `%%view:table%%` on the parent — never ASCII or Markdown tables inside code
   blocks. Fields present on entry initialize visible columns. New fields on an
   existing table require a list-to-table re-entry until PR 2 exposes display
   field configuration. Small inline enumerations stay list.

### Shape

Shape **(b)**: a set of **two independent complete features**, each its own PR;
PR 2 builds on PR 1 but PR 1 is fully shippable and useful alone.

### PR 1 — view-mode awareness (see + set + teach)

- **Read.** Generalize `searchViewModeOf` to a `viewModeOf(index, node)` that
  resolves any owner's `viewDef` child; `outlineNodeText` and `outlineText`
  emit `%%view:<mode>%%` for any owner whose effective mode is not `list`.
  The agent now recognizes "this node is a table" in both `node_read` output
  and the user-view context.
- **Write.** `node_create` / `node_edit` persist the parsed `view` on ordinary
  nodes through the `set_view_mode` command (generalize `applySearchViewSpec`
  into `applyViewSpec`; delete the three "only persisted on search nodes"
  warning sites). On a directive-capable root, `node_edit` treats an omitted
  directive as `list`; it preserves code-block owners whose syntax cannot carry
  one.
  Core's entering-table transaction — search materialize-first, column
  auto-initialization in Schema order — comes for free because it lives inside
  `setViewMode`.
- **Validate** per Principle 2. Repeating the current effective mode is a no-op,
  avoiding an unnecessary `viewDef` on a list owner. An unavailable mode
  is accepted only when the edited root already persists that exact mode.
- **Teach.**
  - `agentNodeToolGuidance.ts`: the task mapping from Principle 4, plus the
    inverse ("an existing `%%view:table%%` node is a table the user sees —
    add rows as child records and values as fields, don't restructure it") and
    the list-to-table re-entry needed to initialize newly used columns.
  - `agentNodeToolSchemas.ts`: mention the directive where `%%search%%` is
    already described.
  - `docs/spec/agent-tool-design.md` Outline section: document the directive,
    the vocabulary rule, and the field→column mapping (same change, per A6).
- **Tests.** Parser round-trip for ordinary nodes; `node_create` with
  `%%view:table%%` over field-bearing records yields display fields (assert
  core state); `node_read` and user-view serialization surface the directive;
  deletion of the directive restores list; explicit list is structurally
  idempotent; an existing unavailable mode survives unrelated edits; rejection
  paths cover newly requested `cards` and unknown strings; table re-entry adds
  newly used fields.

### PR 2 — view-config read/write

- **Read.** When serializing an owner that has a `viewDef`, emit its config as
  typed lines under the owner, in the saved-search rule-line style: sort rules
  (field + direction), filter rules, group field, and — for table — display
  fields with label / width / visibility / order. Emission follows the same
  placement rules as saved-search query lines so depth/limit semantics stay
  uniform.
- **Write.** `node_edit` patches those lines and routes to the existing
  commands (`add/update/remove/clear_sort_rule`, filter equivalents,
  `set_group_field`, `add/update/remove_display_field`). No new core commands.
- **Teach.** Per-view config guidance; note that table columns are hidden, not
  removed, matching the header's Hide-only affordance in the Table View spec.
- **Tests.** Config-line round-trip per rule type; edit paths assert the
  resulting `viewDef` sub-tree; guard that unknown config lines fail closed
  with recovery instructions.
- **Ordering.** Lands after `tag-schema-projection` PR 1 (#545), which reroutes
  agent node reads through projected field slots — same reader files; this is
  sequencing, not a conflict.

## Open questions

- Table over field-less records: `%%view:table%%` still switches (Title-only
  grid), matching the UI. Guidance steers the agent to create fields first.
  Confirm at PR 1 review that this default reads well in practice.
- PR 2 token cost: whether config lines emit whenever the owner serializes
  (saved-search parity) or only at `depth >= 1`. Default is saved-search
  parity; measure real `node_read` output size during PR 2 and decide there.
