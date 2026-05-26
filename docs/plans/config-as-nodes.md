---
status: in-progress
priority: P1
owner: relixiaobo
created: 2026-05-26
updated: 2026-05-26
---

# Config as Nodes — node unification (U1)

Move definition (and view) configuration off `Node`'s flat typed fields and
into the node tree, reusing the **existing field-value mechanism** — a config
value is a child node / reference, exactly like a field value, with its type
known from the registry. Reads go through typed accessors as the single entry
point. The "config panel vs outliner" seam disappears and the data model has
**one** value mechanism, not a parallel one.

History: an earlier sketch introduced a typed `NodeValue` slot; per Codex
review that is a *second* value mechanism (field values are already child
content/reference nodes), so it was dropped. This doc is the U1 model.

## The model (U1)

- A config item = a **`defConfig` node** (dedicated type), child of the
  `tagDef`/`fieldDef`, carrying `configKey`. fieldEntry-shaped for value
  storage so it reuses `OutlinerFieldRow`/`FieldValueOutliner` rendering and
  editing — but a **distinct type** so field/template logic never touches it.
- The value is stored the way field values already are:
  - number / color / bool → a child value node (content text, parsed per
    `configKey`), same as today's field values.
  - ref (`extends`, `childSupertag`, `sourceSupertag`) → a child reference.
  - enum (`fieldType`, `hideField`, `cardinality`) → a child reference to a
    **system option node**; `autoInitialize` → several. An invalid enum value
    is unrepresentable.
- **Reference roles.** `reference` today serves user links, field-option
  values, auto-init values, and search results. We add a role distinction
  (`refRole`, or inference from parent context) so config/enum refs stay **out
  of the backlink graph**, while field-value refs keep whatever backlink
  behavior they have today.
- **System option nodes** (`systemOption` type) hold enum domains; hidden at
  the **projection layer**, not merely absent from the Schema view.
- **Reads via accessors + a config index.** `projectTagConfig` /
  `projectFieldConfig` over a `buildConfigIndex(state)` (not a child scan per
  call — config is read in hot paths: outliner rows, search, field options,
  agent projection).
- Schema registry (canonicalized in `src/core`) is the authoritative closed
  schema: `configKey` → domain, cardinality, `appliesTo`, `visibleWhen`,
  label/icon, optional `validate`.

## Review-driven constraints (must hold)

1. **`showCheckbox` is dual-purpose** — a per-node checkbox affordance
   (`core.ts:2418` done toggle/cycle) *and* tag config (`core.ts:970`). Split
   the node affordance from the tag default **before** removing it from `Node`.
2. **Structural protection from day one** — `defConfig`/`systemOption` must be
   excluded from outliner rendering (`shared.ts` filter), template content
   cloning (`getTemplateContentNodes`, `core.ts:2048`), drag/copy/duplicate,
   agent projection (`agentNodeToolProjection.ts`), sidebar, and search — not
   deferred. Otherwise config rows get displayed/dragged/copied/instantiated.
3. **Migration precedence** — until the write path switches, flat fields are
   the source of truth. `setTagConfig`/`setFieldConfig` **dual-write** (flat +
   subtree), or accessors **read flat-first**. Pick dual-write; flip to
   subtree-as-truth only once all writes are migrated.
4. **`value.ref` is too coarse** → reference roles (above).
5. **Scope boundary** — field *values* stay as today's child content/reference
   nodes (already node-shaped); we are **not** introducing a typed value slot
   for them. Unification = config uses the same node-value mechanism, not a new
   one.
6. **viewDef in the same batch** — view-rule params (`sortField`,
   `filterField`, `filterOperator`, `filterValues`, `displayField`,
   `groupField`; `outlinerRows.ts:66`, `searchEngine.ts`) migrate on the same
   read/write rules as definition config, or we drop `projectViewRule` until
   they do. No half-promise.
7. **Hidden system options need product-level hiding** — projection-layer
   exclusion so normal-child / search / agent / sidebar paths don't each
   re-implement it.
8. **Accessors need caching** — `buildConfigIndex`, not per-call scans.
9. **Tests per stage** — "green" must mean behavioral tests, not just
   typecheck: migration idempotency, dual-write precedence, structural lock,
   template-not-cloning-config, backlinks-exclude-config-refs, view-rule
   parity.

## Scope (honest)

Foundational: `types.ts`, `loroDocument.ts`, `core.ts` (commands, migration,
reconcile, accessors, guards, refRole), projection, the ~234+ flat config/view
field reads across `src`/`tests` (`.fieldType` alone is 66), viewDef readers,
config UI, agent tools, E2E mocks. The reader rewrite is the long tail.

## Stages (one PR; each stage ships behavioral tests + stays green)

0. **Definitions, no behavior change** — closed schema registry,
   `defConfig`/`systemOption` types, refRole taxonomy, accessor API surface,
   migration-precedence rule.
1. **Protection + persistence + guard (day one)** — full structural exclusion
   (render/template/drag/copy/agent/sidebar/search) + projection-layer hiding +
   structural guard for `defConfig`/`systemOption`. Tests for each.
2. **Split `showCheckbox`** — node checkbox affordance vs tag config; done
   toggle/cycle unaffected (tests).
3. **Accessors + `buildConfigIndex`** — flat-first precedence during
   transition.
4. **Seed system option nodes + `reconcileConfigSubtree`** — idempotent;
   appliesTo+visibleWhen; registry order.
5. **Migration + dual-write** — materialize subtrees from flat fields;
   commands dual-write. Tests: idempotency, parity.
6. **Reader rewrite (long tail)** — by subsystem, each green + tested.
7. **Flip source of truth** — subtree-only writes; accessor value-first;
   dual-write removed; guard chokepoint final.
8. **Config UI as rows + viewDef params** — reuse field-value rendering for
   config rows; delete `DefinitionConfigPanel`/`Controls`/`RowShell`; migrate
   view-rule params on the same rules.
9. **Remove flat fields + final verify** — only after agent tools, E2E mocks,
   renderer projection are all off flat config fields; remove from
   `Node`/persistence/projection; visual verify; mark PR ready.

## Consistency note

Node-encodes definition + view config, reversing `nodex-parity-decisions.md:38`
("we chose typed" for viewDef filters). Chosen deliberately for a uniform
end-state. Update that entry on merge — main-agent call.
