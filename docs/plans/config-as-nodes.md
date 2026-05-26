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

History: a typed `NodeValue` slot (a *second* value mechanism — field values
are already child nodes) was dropped per review. This is the U1 model, refined
by two Codex review passes (model direction endorsed; risks are transitional).

## The model (U1)

- Config item = a **`defConfig` node** (dedicated type), child of the
  `tagDef`/`fieldDef`, carrying `configKey`. fieldEntry-shaped so it reuses
  `OutlinerFieldRow`/`FieldValueOutliner` rendering/editing — but a distinct
  type so field/template logic never touches it.
- Value stored as field values already are: number/color/bool → child value
  node (content text, per the registry **codec**); ref/enum → child
  `reference` (enum → a **system option node**).
- **`systemOption` nodes** hold enum domains. **Stable IDs derived from the
  registry key/domain** (`systemOptionNodeId`), never `freshId`.

## Transitional-state rules (the actual risk — from review)

These are non-negotiable; getting them wrong corrupts documents mid-migration.

1. **Two-layer visibility, NOT projection removal.** `defConfig`/`systemOption`
   stay **in** `DocumentProjection` (`projection.ts:15` projects every node;
   the renderer resolves reference labels via the projection, so enum/ref value
   labels need their target present). A single `isInternalNode(node)` predicate
   excludes them at every *consumer*: outliner normal-child render
   (`shared.ts:73`), **search candidates** (`searchEngine.ts` runs over
   `DocumentState`, not the projection — must filter at the index layer), agent
   projection (`agentNodeToolProjection.ts`), sidebar. The config *surface*
   opts **in** to rendering `defConfig` children.
2. **Visible↔raw child-index translation.** `defConfig` nodes are a pinned
   internal segment of a definition's `children`. Every definition-child
   `moveNode`/`createNode`/`createFieldDef`/insert must translate the visible
   index to a raw index (skipping the internal segment), or a drag to "index 0"
   lands among/before config. Route all definition-child structural ops through
   one helper.
3. **Guard granularity — structure locked, value mutable.** A dedicated
   chokepoint: the `defConfig` node itself cannot be renamed/reparented/
   deleted/reordered, but its value is set via a registry-governed
   `setConfigValue` (replace/set), **not** raw child create/delete.
   `systemOption` nodes are fully immutable.
4. **Explicit `refRole` + backlink allowlist.** Add `refRole`
   (`link`/`fieldValue`/`config`/`enum`/`searchResult`/`autoInit`). Backlink &
   reference-cleanup logic (keyed today on `type==='reference' && targetId` in
   ~15 spots, e.g. `core.ts:1397`, `2278`, `2353`) switches to an **allowlist**
   (link/tree/fieldValue in; config/enum/system/searchResult out). Migration
   backfills `refRole` by context; do not rely on parent inference long-term.
5. **Scalar codec in the registry.** Each scalar knob declares canonical
   storage text, empty/unset/default semantics, write-time validation, and
   reconcile for invalid persisted values — enum unrepresentability does not
   cover number/bool/color stored as text.
6. **viewDef rides with config.** view-rule params (`sortField`,
   `filterField`, `filterOperator`, `filterValues`, `displayField`,
   `groupField`; written `core.ts:448`, read `outlinerRows.ts:66`,
   `searchEngine.ts:231`) migrate/dual-write/reader-rewrite in the **same**
   stages as definition config, flip together in Stage 7. No half-promised
   `projectViewRule`.
7. **Lint gate.** An `rg`/test fails on new direct reads of moved flat fields
   (~153 in `src`) outside an allowlist (migration/dual-write/accessor/legacy
   tests) — the compiler won't stop them while the fields still exist.
8. **`showCheckbox` is dual-purpose** (node affordance `core.ts:2418` + tag
   config `core.ts:970`) — split before removal from `Node`.

## Reads via accessors + index

`projectTagConfig`/`projectFieldConfig`/`projectViewRule` over a
`buildConfigIndex(state)` (config is read in hot paths: outliner rows, search,
field options, agent projection — no per-call child scans). Flat-first
precedence during transition; value-first after Stage 7.

## Scope (honest)

Foundational: `types.ts`, `loroDocument.ts`, `core.ts` (commands, migration,
reconcile, accessors, guards, refRole, index translation), `projection.ts`,
`searchEngine.ts`, the ~153 flat config/view reads across `src`, viewDef
readers, config UI, agent tools, E2E mocks. The reader rewrite is the long tail.

## Stages (one PR; each ships behavioral tests + stays green)

0. **Definitions, no behavior change** — closed schema registry (domains,
   cardinality, appliesTo, visibleWhen, **scalar codecs**, validate),
   `defConfig`/`systemOption` types, `refRole` taxonomy + backlink allowlist
   design, `isInternalNode` predicate, visible↔raw index helper API,
   `setConfigValue` chokepoint API, migration-precedence rule.
1. **Internal-node infra + protection (day one)** — `isInternalNode` wired into
   outliner render, **search candidates**, agent projection, sidebar (kept in
   projection); visible↔raw child-index translation for all definition-child
   ops; structural guard (lock `defConfig`/`systemOption` structure) +
   `setConfigValue` chokepoint; persistence. Test per protection (incl. index
   translation, template-not-cloning-config, search-excludes-config).
2. **Split `showCheckbox`** — node affordance vs tag config; done toggle/cycle
   unaffected (tests).
3. **`refRole` + backlink allowlist** — add `refRole`; switch backlink/reference
   logic to allowlist; migration backfills by context. Tests: backlinks exclude
   config/enum refs; field-value refs unchanged.
4. **System options (stable IDs) + reconcile + accessors + index** — covers
   definition **and** view config domains.
5. **Migration + dual-write (config + view)** — materialize subtrees from flat
   fields (codec-validated); commands dual-write. Tests: idempotency, parity,
   invalid-value reconcile.
6. **Reader rewrite (config + view), by subsystem** + **lint gate**. Each green
   + tested.
7. **Flip source of truth (config + view together)** — subtree-only writes;
   accessor value-first; dual-write removed; guard chokepoint final.
8. **Config UI as rows (UI-only)** — reuse field-value rendering via
   `setConfigValue`; delete `DefinitionConfigPanel`/`Controls`/`RowShell`. No
   data migration here.
9. **Remove flat fields + final verify** — only after agent tools, E2E mocks,
   renderer projection are off flat config fields; remove from
   `Node`/persistence/projection; full suite + build; visual verify; mark ready.

## Consistency note

Node-encodes definition + view config, reversing `nodex-parity-decisions.md:38`
("we chose typed" for viewDef filters). Deliberate, for a uniform end-state.
Update that entry on merge — main-agent call.
