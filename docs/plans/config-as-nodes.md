---
status: done
priority: P1
owner: relixiaobo
created: 2026-05-26
updated: 2026-05-27
---

> **Shipped in PR #18** (merged 2026-05-27). All stages (0–10) complete. Three
> correctness issues were found and fixed in review before merge: stable
> `defConfig` ids on subtree clone, `searchResult` refRole on saved-search result
> refs, and `outlinerChildren` excluding internal config nodes.

# Config as Nodes — node unification (U1)

Move definition **and view** configuration off `Node`'s flat typed fields into
the node tree, reusing the **existing field-value mechanism** — a config value
is a child node / reference, type known from the registry; reads go through
typed accessors backed by an index. One value mechanism, not a parallel one.
The "config panel vs outliner" seam disappears.

History: a typed `NodeValue` slot was dropped (it would be a *second* value
mechanism). Two Codex review passes endorsed the U1 direction and surfaced the
transitional-correctness rules below.

**Pre-launch: no backward-compat.** The product has not launched, so there is
no persisted user data to preserve. This removes the migration machinery —
there is no idempotent legacy-doc backfill, no dual-write, no read-precedence,
no lint gate. The cutover is **compiler-driven**: delete a flat field and the
type checker enumerates every reader/writer to fix. The runtime-correctness
work below is unaffected.

## The model (U1)

- Config item = a **`defConfig` node** (dedicated type), child of the
  `tagDef`/`fieldDef`, carrying `configKey`. fieldEntry-shaped so it reuses
  `OutlinerFieldRow`/`FieldValueOutliner` rendering/editing — but a distinct
  type so field/template logic never touches it.
- Value stored as field values already are: number/color/bool → child value
  node (content text, per the registry **codec**); ref/enum → child
  `reference` (enum → a **system option node**).
- **`systemOption` nodes** hold enum domains; **stable IDs derived from the
  registry key/domain** (`systemOptionNodeId`), never `freshId`.
- Reads via `projectTagConfig`/`projectFieldConfig`/`projectViewRule` over a
  `buildConfigIndex(state)` (config is read in hot paths — no per-call scans).

## Runtime-correctness rules (still required — not migration)

1. **Two-layer visibility, NOT projection removal.** `defConfig`/`systemOption`
   stay **in** `DocumentProjection` (the renderer resolves reference labels via
   the projection). A single `isInternalConfigNode` predicate excludes them at
   each *consumer*: outliner render (`shared.ts`/`outlinerRows.ts`), search
   candidacy (allowlist already does), agent `normalChildIds`, sidebar. The
   config surface opts **in**.
2. **Visible↔raw child-index translation.** `defConfig` nodes are a pinned
   internal segment of a definition's `children`; definition-child
   move/insert/create must translate visible→raw index (skip the segment).
3. **Guard granularity — structure locked, value mutable.** The `defConfig`
   node itself can't be renamed/reparented/deleted/reordered (done via the
   `ensure*` guards); its value is set only via a registry-governed
   `setConfigValue` chokepoint (`*Direct` APIs). `systemOption` immutable.
4. **Explicit `refRole` + backlink allowlist.** `refRole`
   (`link`/`fieldValue`/`config`/`enum`/`searchResult`/`autoInit`); backlink &
   reference logic uses an allowlist (link/fieldValue in; config/enum/system/
   searchResult out), not parent inference.
5. **Scalar codec in the registry** — canonical text, unset/default, write-time
   validation for number/bool/color.
6. **viewDef rides with config** — view-rule params migrate to the value
   mechanism in the same stages and cut over together.
7. **`showCheckbox` / `doneStateEnabled` are dual-purpose** — audited:
   - **Content-node affordance (STAYS on `Node`; NOT removed in Stage 6):**
     `set_node_checkbox_visible` (core:450), done toggle/batch (core:778/849),
     `createInlineField` reset (core:1058), `cycleNodeDoneState` (core:2419),
     search `TODO`/`NOT_DONE` (searchEngine:508), NodePanel/OutlinerItem/
     userViewContext display.
   - **TagDef config (redirect to subtree/accessor only):** `setTagConfig`
     (core:971) + `DefinitionConfigPanel` UI + renderer registry.
   So these two fields are kept on `Node`; only their tagDef-config role moves
   to the subtree. The "split" is realized during cutover via this
   classification, not as standalone pre-work.

## Cutover (no compat → compiler-driven)

Writes produce the subtree as the source of truth; accessors read it. Then
**delete each flat field from `Node`** — the type checker lights up every reader
(~153 in `src`) and writer; fix them to the accessor / `setConfigValue`. No
dual-write, no backfill: field-by-field, each step compiles green.

## Stages (one PR; each stage ships behavioral tests + stays green)

0. ✅ **Definitions** — `defConfig`/`systemOption` types, `RefRole`, closed
   schema registry + scalar codecs + enum domains, `isInternalConfigNode`,
   backlink allowlist, accessor/index/`setConfigValue` API surface.
1. **Protection + guard + index translation** (in progress) — `isInternalConfigNode`
   wired into outliner/agent/sidebar (search already allowlist); structural
   guards; visible↔raw index translation. Tests per protection.
2. **Split `showCheckbox`** — node affordance vs tag config; done toggle/cycle
   unaffected (tests).
3. **`refRole` + backlink allowlist** — add `refRole`; switch backlink/reference
   logic to the allowlist. Tests: backlinks exclude config/enum refs.
4. **System options + reconcile + accessors + index (config + view)** — seed
   enum subtrees (stable IDs); `reconcileConfigSubtree`; `buildConfigIndex` +
   accessors.
5. **Cutover** — config (and view) writes produce the subtree as source of
   truth; accessors read it.
6. **Remove flat fields (compiler-driven) + reader/writer rewrite** — delete
   moved fields from `Node`/persistence; fix every compile error to
   accessor/`setConfigValue`, by subsystem, each green + tested.
7. **Config UI as rows + final verify** — render config rows reusing
   `OutlinerFieldRow`/`FieldValueOutliner` via `setConfigValue`; delete
   `DefinitionConfigPanel`/`Controls`/`RowShell`; full suite + build; visual
   verify; mark ready.

## Scope addendum (2026-05-27): full discriminated `Node` union (A-full)

The user expanded scope: **this same PR** also turns the entire ~60-field
god-record `Node` into a **discriminated union of all node types** (A-full),
eliminating the god-record. This coexists with defConfig rather than reversing
it — the two answer different questions:

- **Where config values live** (defConfig): *semantic/queryable* config →
  child nodes; *presentation state* (view rules) → typed fields.
- **How each node is typed** (A-full): every node type gets a precise variant
  shape. `defConfig` variant = `{ configKey }`; `sortRule` = `{ sortField,
  sortDirection }`; `tagDef`/`fieldDef` = clean base (config in child nodes);
  content node = clean base.

So **view-rule params stay typed fields** (view = presentation state → typed),
but on their dedicated node-type *variants*, off the shared interface. This
reverses the earlier "migrate view into the value mechanism" idea (rule 6):
view is NOT defConfig-ified; it is typed via the union. Definition config alone
uses defConfig.

### Coordination caveats (record in PR body for the main agent)

`src/core/types.ts` is a coordination-required protocol file; cc-2 + codex
build concurrently on `Node` (conflict storms on rebase); a dev agent can't
merge, so the main agent receives a large, hard-to-review change; persistence
(`loroDocument` flat scalar map) is touched. The user accepted these. Mitigate
with tight, individually-green commits and explicit PR notes.

### A-full stages (after defConfig Stages 0–7; each stays green)

8. **Per-type variant interfaces** — define `BaseNode` + one interface per
   `NodeType` (and the `type?: undefined` content variant). Introduce `Node`
   as their union additively; keep field set identical at first so nothing
   breaks (structural no-op), then start narrowing.
9. **Narrow access sites by `node.type`** — subsystem by subsystem (core,
   projection, persistence, searchEngine, agent, renderer), replace god-record
   field reads with type-narrowed access. Each subsystem green + tested.
10. **Remove cross-variant fields** — once readers narrow, delete fields from
    variants that shouldn't carry them; god-record gone. Persistence reads/writes
    per-variant key sets.

#### A-full status (2026-05-27): DONE

Stages 8–10 are complete. Every **content-type-specialized** field now lives on
its owning variant, moved group-by-group (each group = one green commit):

- media → `CodeBlockNode.codeLanguage`, `ImageNode.{assetId,mediaUrl,mediaAlt,
  imageWidth,imageHeight}`, `EmbedNode.{embedType,embedId,sourceUrl}`
- query → `QueryParams` mixin `{queryLogic,queryOp,queryTagDefId,queryFieldDefId,
  queryTargetId}` on `SearchNode` + `QueryConditionNode`
- view → `ViewDefNode.{viewMode,toolbarVisible,groupField}`, `SortRuleNode`,
  `FilterRuleNode`, `DisplayFieldNode`
- defConfig → `DefConfigNode.configKey`; fieldEntry → `FieldEntryNode.fieldDefId`
- reference → `ReferenceNode.{targetId,refRole}`

The query-rule target that `search`/`queryCondition` nodes shared with references
under the bare name `targetId` was split out to `queryTargetId` (a `QueryParams`
sibling of `queryFieldDefId`/`queryTagDefId`), so `targetId` is now unambiguously
the reference pointer.

`NodeBase` deliberately keeps the fields that are **uniform across every node**:
structural identity (`id`/`parentId`/`children`/`content`/`tags`/timestamps/
`locked`/`trashedFrom*`) plus the presentation/state any node may carry
(`completedAt`, `icon`/`iconKind`, `banner*`, `description`, `aiSummary`,
`templateId`, `autoCollected`). These are written through generic per-node
setters (any node can be a task or carry an icon/banner) — they are domain-correct
on the base, not god-record residue, and do not block `node.type` narrowing.

## Behavioral parity (nodex/Tana-verified, 2026-05-27)

Before migrating each config knob we confirmed the intended semantics against
nodex (source) and Tana (docs). Verdicts:

- **Most knobs are already correct** and only need storage migration: color
  (visual), fieldType stale-state clearing, sourceSupertag (options from tagged
  nodes), autocollectOptions, autoInitialize (4 strategies + priority),
  cardinality (lin enforces at write-time — stricter than nodex, keep), hideField
  (lin implements all 5 modes incl. `value_is_default` — more complete than nodex,
  keep), nullable/required (UI-only, matches Tana's non-blocking red-asterisk).
- **Template inheritance through `extends`** = fields + default content (Tana:
  "template content" inherited wholesale, inherited content locked). Content
  inheritance was a pre-existing gap — **fixed** (ancestor-first, dedup by
  templateId).
- **`childSupertag` does NOT inherit through `extends`** — Tana evidence shows
  extends inherits the *template*, not tag-level config knobs like Child
  supertag. lin's current behavior is correct; **no change**.
- **Done-state mapping (`doneStateEnabled`)** — Tana feature confirmed: a
  two-way map from checkbox state to **one or more** options/enum field values
  (check → set each mapped field's checked value; set a mapped checked/unchecked
  value → toggle the checkbox). Gated by Show-as-Checkbox. lin only had a bare
  boolean — **implement full multi-field mapping this iteration**.
  - Data model (config-as-nodes consistent): under the tagDef, the
    `doneStateEnabled` gate + a list of mapping-entry nodes, each
    `{ field (ref), checkedValue (option ref), uncheckedValue (option ref) }`.
    Forward sync in the done toggle (single write); reverse sync in
    select-field-option (single write, loop-guarded). Options/enum fields only.
- **`minValue`/`maxValue` runtime validation** — Tana shows a **non-blocking**
  warning when a number value is out of range (does not reject). lin only checks
  min≤max at config time — **add the soft runtime warning this iteration**.

## Consistency note

Node-encodes **definition** config (defConfig); **view** config stays typed but
moves onto per-type union variants (A-full). This reverses
`nodex-parity-decisions.md:38` for definition config only ("we chose typed" for
viewDef filters) — view config remains typed, just no longer on the god-record.
Update that entry on merge — main-agent call.
