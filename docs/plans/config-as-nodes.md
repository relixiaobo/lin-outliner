---
status: in-progress
priority: P1
owner: relixiaobo
created: 2026-05-26
updated: 2026-05-26
---

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
7. **`showCheckbox` is dual-purpose** (node affordance `core.ts:2418` + tag
   config `core.ts:970`) — split before removal from `Node`.

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

## Consistency note

Node-encodes definition + view config, reversing `nodex-parity-decisions.md:38`
("we chose typed" for viewDef filters). Deliberate, for a uniform end-state.
Update that entry on merge — main-agent call.
