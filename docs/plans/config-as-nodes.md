---
status: in-progress
priority: P1
owner: relixiaobo
created: 2026-05-26
updated: 2026-05-26
---

# Config as Nodes

Make tag/field configuration a first-class part of the node graph instead of a
separate form panel. Each config item becomes a real node that renders, is
navigated, selected, and undone through the same machinery as ordinary
outliner rows. The "config panel vs outliner" seam disappears.

## Goal

A `tagDef` / `fieldDef` is just a node whose children include its
configuration. Opening it shows one continuous outline:

```
#Task (tagDef)
├─ ⚙ color            → #7C9            (color control on the config row)
├─ ⚙ extends          → [ref → #Project]
├─ ⚙ show as checkbox → on
├─ ⚙ done state       → on             (present only when checkbox = on)
├─ ⚙ default child    → [ref → #Subtask]
└─ … default content (ordinary content rows, same surface)
```

The felt result: configuring a definition uses the same keyboard, selection,
and editing model as writing notes — no modal, no parallel control layer.

## Non-goals

- Not changing what is configurable (the knob set stays as today).
- Not migrating `viewDef` filter/sort/display config in this PR (see
  **Consistency conflict** below).
- Not building new config features (done-state mapping editor, auto-collect
  list) here — those are follow-ups once the surface is unified.

## Consistency conflict (read before reviewing)

This reverses, for definition config, a decision recorded in
[`nodex-parity-decisions.md`](nodex-parity-decisions.md): *"`Filter` rules as
child nodes of `viewDef` … nodex's child-node encoding is more composable but
less type-safe; we chose typed."* lin currently stores definition config as
**typed flat fields** on the node (`src/core/types.ts:256` `Node` — `color`,
`extends`, `fieldType`, `cardinality`, …).

Going node-encoded for tag/field config makes the codebase internally
inconsistent (config = nodes, but `viewDef` filter/sort = typed flat). The
owner chose node-encoding deliberately for the unification payoff. Open
question for the main agent: either accept the temporary inconsistency, or
plan a follow-up to migrate `viewDef` config the same way. The
parity-decisions entry should be updated on merge.

## Design

### Source of truth + backward-compatible reads

The **document** stores config as `defConfig` child nodes (new node type). The
**projection** derives the legacy flat fields back onto the parent
`NodeProjection`, so every existing reader (rendering, queries, done-state,
auto-init, agent projection) is untouched. Blast radius is contained to:

1. the core write + projection-derivation layer, and
2. the config UI (which is deleted and re-expressed as rows).

```
write:  set_tag_config / set_field_config / direct row edit
          → mutate defConfig subtree (guarded)
read:   build projection → derive node.color/extends/fieldType/… from subtree
          → all existing readers see the same flat fields as before
```

### Node schema

```ts
// new NodeType: 'defConfig'
// a config item is a system field-node on a tagDef/fieldDef
interface DefConfigNode {
  type: 'defConfig';
  configKey: DefConfigKey;   // 'color' | 'extends' | 'fieldType' | … → schema lookup
  parentId: NodeId;          // the tagDef / fieldDef
  system: true;              // structural lock: no delete / reparent / reorder / rename
  children: NodeId[];        // ref/enum values live here
  // scalar/bool values live in the typed leaf fields below
}
```

Value representation by domain:

| Config keys | Domain | Stored as |
| --- | --- | --- |
| `extends`, `childSupertag`, `sourceSupertag` | ref | one child `reference` node → target tagDef |
| `fieldType`, `cardinality`, `hideField` | enum | one child `reference` → a **system option node** |
| `autoInitialize` | enum list | child `reference`s → strategy option nodes |
| `minValue`, `maxValue` | number | typed leaf field on the `defConfig` node |
| `color` | color | typed leaf field on the `defConfig` node |
| `showCheckbox`, `doneStateEnabled`, `required`, `autocollectOptions` | bool | typed leaf field on the `defConfig` node |

Enums become "options fields whose options are system nodes", reusing the
existing `options_from_supertag` value machinery. Selecting a value = a
reference; an invalid enum value is therefore **unrepresentable**.

### System option nodes

A new system subtree under `SCHEMA_ID` holds the enum domains:

```
SCHEMA/
  field-types/    plain, options, options_from_supertag, date, number, …
  hide-modes/     never, empty, not_empty, value_is_default, always
  cardinalities/  single, list
  auto-init/      current_date, ancestor_day_node, ancestor_field_value, ancestor_supertag_ref
```

Seeded at document bootstrap; idempotent migration adds them to existing docs.

### Schema registry

`definitionConfig.ts` evolves from a render-only list into the authoritative
**closed schema**:

```ts
interface ConfigSchemaDef {
  key: DefConfigKey;
  kind: 'tag' | 'field';
  domain: ConfigDomain;                  // ref | enum | enumList | number | bool | color
  cardinality: 'single' | 'list';
  appliesTo: '*' | FieldType[];
  visibleWhen?: (cfg: ProjectedConfig) => boolean;
  label: string; icon: IconKind; description?: string;
  validate?: (value, ctx) => void;       // only cycle / min-max remain
}
```

### Invariants

| Invariant | Enforced by |
| --- | --- |
| Enum value legal | structurally (can only reference an existing option node) |
| Membership closed (only registry keys) | `reconcileConfigSubtree` |
| Order fixed (registry order) | `reconcileConfigSubtree` + render |
| No delete / reparent / reorder / rename | command layer rejects on `system` nodes |
| Value-domain typed | write-time domain check |
| `extends` acyclic | guard (reference-graph cycle check) |
| `min ≤ max`, finite | domain `validate` |
| Applicability follows `fieldType` | `reconcileConfigSubtree` (appliesTo) |

### Validation convergence — single chokepoint

```ts
function guardConfigMutation(defNode, configKey, nextValue, ctx): void {
  CONFIG_SCHEMA[configKey].validate?.(nextValue, ctx);   // cycle / min-max
  // structural invariants come from the command layer refusing structural
  // ops on system nodes; enum legality is structural (reference must exist)
}
function reconcileConfigSubtree(defNode): void {
  // recompute applicable defConfig children by appliesTo:
  // prune non-applicable, create newly-applicable, order by registry
  // (replaces the imperative "clear sourceSupertag/min/max on type change")
}
```

`set_tag_config` / `set_field_config` survive as **thin typed facades**: each
patch key writes its value (leaf field or reference child) and hits the guard.
The row UI edits the same nodes directly and hits the same guard. One source
of validation truth, no bypass.

Existing `core.ts` checks map cleanly:

| Old (imperative, scattered) | New (declarative, single) |
| --- | --- |
| validate fieldType/hideField/cardinality enum | structural (reference an option node) |
| clear sourceSupertag/autocollect/min/max on type change | `reconcileConfigSubtree` |
| `extends` not cyclic | `guardConfigMutation` |
| `min ≤ max`, finite number | domain `validate` |
| `required` ↔ `nullable` inversion | derivation/accessor mapping (unchanged behavior) |

### Rendering + keyboard (inherited, not rebuilt)

- `buildOutlinerRows` / `buildChildRows` emit a `defConfig` row from the
  subtree; a new `RowLeading` variant draws the config bullet.
- The control (color swatch / number / switch / ref picker / enum picker) is
  chosen by `domain` and rendered inside `FieldEntryGrid`, exactly as
  `OutlinerFieldRow` renders a field value.
- Navigation, multi-row selection, focus, and undo are **inherited** because
  config rows are nodes in `flattenVisibleRows`. Drag-reorder and delete are
  suppressed for `system` nodes.
- `visibleWhen` / `appliesTo` are resolved at `reconcile` time (the node is
  present or not), so the renderer needs no special filtering.
- Deleted: `DefinitionConfigPanel.tsx`, `DefinitionConfigControls.tsx`,
  `DefinitionConfigRowShell.tsx`, and the separate `<section>` in
  `NodePanel.tsx:705`.

## Staged commits (one PR)

Each stage keeps `bun run typecheck` + tests green and the app runnable.

1. **Schema + types** — `NodeType` `'defConfig'`, `DefConfigKey`,
   `ConfigDomain`, `ConfigSchemaDef`; system option node ids/seed.
2. **Document layer** — bootstrap seeds option nodes + config subtrees;
   idempotent migration for existing docs; `reconcileConfigSubtree`.
3. **Projection derivation** — derive legacy flat fields from the subtree so
   all readers stay green (no reader edits).
4. **Write path + guard** — `set_tag_config`/`set_field_config` rewritten as
   facades over subtree writes; `guardConfigMutation`; structural-op locks for
   `system` nodes.
5. **Render config as rows** — row type + leading variant + domain controls;
   wire into `buildChildRows`.
6. **Keyboard/selection** — confirm inherited nav across config + content;
   suppress drag/delete on system nodes.
7. **Delete old UI** — remove the three definition-config components and the
   panel section; clean styles.
8. **Tests** — migration idempotency, projection-derivation parity vs current
   flat-field behavior, guard validation, reconcile on type change.

## Open questions

- `viewDef` consistency (see **Consistency conflict**) — main-agent call.
- Scalar/bool values as leaf fields on `defConfig` vs literal child nodes:
  chosen leaf fields (a literal node per number/bool is noise); revisit only if
  a future feature needs them addressable.
- Undo granularity for `reconcileConfigSubtree` (should a type change + its
  prune/create be one undo step — yes).
