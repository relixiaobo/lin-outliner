---
status: in-progress
priority: P1
owner: relixiaobo
created: 2026-05-26
updated: 2026-05-26
---

# Config as Nodes — full node unification

Move lin's data model from a flat typed god-record (`Node` with ~60 typed
fields) to a **node-uniform model**: a generic node carries a single typed
`value`; definition and view configuration live as child value-nodes; readers
go through typed accessors. The "config panel vs outliner" seam disappears
*and* the data model becomes internally uniform (no flat-field/node hybrid).

This supersedes the earlier hybrid sketch, which kept config values split
across leaf fields and reference children, reused the god-record's own fields,
kept a derived flat-field cache, and overloaded user references for enums —
four smells. The clean model below removes all four.

## Goal

```
#Task (tagDef)
├─ ⚙ color            value:{color:#7C9}
├─ ⚙ extends          value:{ref:#Project}
├─ ⚙ show as checkbox value:{bool:true}
├─ ⚙ default child    value:{ref:#Subtask}
└─ … default content (ordinary content rows, same surface)

priority (fieldDef)
├─ ⚙ field type       value:{ref: schema-option:number}
├─ ⚙ minimum value    value:{number:0}
└─ ⚙ required         value:{bool:false}
```

A definition is just a node whose children include its configuration; a config
row is a node; the UI is a pure projection of nodes. One rendering path, one
keyboard model, one selection/undo model.

## Non-goals

- No new config *features* (done-state mapping editor, auto-collect list) — the
  surface is unified first; features follow.

## The clean model

### 1. `Node` slims; one polymorphic value slot

The config/view typed fields leave `Node`. Value-bearing nodes carry a single
tagged union:

```ts
type NodeValue =
  | { kind: 'text' }                  // value is the node's content (RichText)
  | { kind: 'number'; number: number }
  | { kind: 'bool'; bool: boolean }
  | { kind: 'color'; color: string }
  | { kind: 'ref'; ref: NodeId }      // points to a node (tag, or system option)
  | { kind: 'date'; date: string };
```

All scalar/bool/color/ref/enum values go through `value`. No split storage, no
reuse of namesake god-record fields.

### 2. Configuration is a child subtree

`tagDef` / `fieldDef` own `defConfig` children, one per applicable knob,
carrying `configKey` + a `value` (single) or child value-refs (list, e.g.
`autoInitialize`). Ordered by the registry; structurally locked (no user
delete / reparent / reorder / rename).

### 3. Config refs are value-refs, not `reference` nodes

A config/enum ref is `value:{kind:'ref'}`, distinct from the user-facing
`reference` node type. It therefore does **not** enter the backlink / inline-ref
graph. Enums = `value.ref` → a **system option node** (see below); an invalid
enum value is unrepresentable.

### 4. System option nodes (enum domains)

Hidden system subtrees hold the enum domains (field-types, hide-modes,
cardinalities, auto-init strategies). Seeded at bootstrap, idempotent for
existing docs, kept out of the user-visible Schema view.

### 5. Reads go through typed accessors — no derived flat cache

```ts
projectTagConfig(tagDefId): TagConfig
projectFieldConfig(fieldDefId): FieldConfig
projectViewRule(ruleId): ViewRule
```

Every current reader of `node.color` / `node.fieldType` / `node.filterField` /
… is rewritten to read through an accessor. The flat fields are **removed** from
`Node`/projection (not kept as a cache). Single source of truth.

### 6. viewDef unification

`sortRule` / `filterRule` / `displayField` are already child nodes; their
parameters (`filterField`, `filterOperator`, `filterValues`, `sortField`,
`displayField`, …) move to `value` slots / value-refs too, on the same
`NodeValue` mechanism. Definition + view config become one uniform node model.

### 7. Schema registry = closed schema

`definitionConfig.ts` (moved/canonicalized into core) declares each knob: key,
`valueKind`, `cardinality`, `appliesTo`, `visibleWhen`, label/icon/description,
optional `validate`. It is the authoritative closed schema that keeps the open
node tree from drifting.

### Invariants

| Invariant | Enforced by |
| --- | --- |
| Enum value legal | structural (`value.ref` must resolve to an option node in the right subtree) |
| Membership closed, registry order | `reconcileConfigSubtree` |
| No delete / reparent / reorder / rename of config nodes | command layer rejects on `defConfig` |
| Value kind matches knob | write-time `valueKind` check |
| `extends` acyclic | guard (value-ref graph cycle check) |
| `min ≤ max`, finite | knob `validate` |
| Applicability follows `fieldType` | `reconcileConfigSubtree` (appliesTo) |

## Scope (honest)

This is a foundational data-model rewrite, not a config feature. Touches:
`types.ts` (slim `Node`, `NodeValue`), `loroDocument.ts` (persist value union,
drop flat keys), `core.ts` (commands, migration, reconcile, accessors),
projection, **every reader of the moved fields** (rendering, queries,
done-state, auto-init, search, agent projection, fieldOptions, tag colors, …),
viewDef rule readers, the config UI, and tests. The reader rewrite is the long
tail and the bulk of the effort.

## Staged commits (one PR, each keeps typecheck + tests green)

1. **Value model + persistence** — `NodeValue` union; persist it; `configKey`
   already added. (Flat fields stay during migration; removed in stage 9.)
2. **Typed accessors** — `projectTagConfig`/`projectFieldConfig`/`projectViewRule`
   reading the value subtree (flat-field fallback while both coexist).
3. **System option nodes + subtree creation + `reconcileConfigSubtree`**.
4. **Migration** — idempotently materialize value subtrees from existing flat
   fields for every tagDef/fieldDef (+ viewDef rules in stage 8).
5. **Reader rewrite** — route all readers through accessors; remove flat-field
   reads. The long tail; split into reviewable sub-commits by subsystem.
6. **Write path + guard + structural locks** — commands write the value
   subtree; `guardConfigMutation`; lock `defConfig` structural ops.
7. **Config UI as rows** — config rows from the subtree; domain controls bound
   to `value` slots; delete `DefinitionConfigPanel`/`Controls`/`RowShell`.
8. **viewDef rule params → value-nodes** — same mechanism for
   filter/sort/display.
9. **Remove flat fields** from `Node`, persistence, and projection.
10. **Tests + visual verify** — migration idempotency, accessor parity, guard,
    reconcile, structural locks; visual check; mark PR ready.

## Open questions

- Order of the reader rewrite (stage 5) — by subsystem; keep each sub-commit
  green.
- Whether `value:{kind:'text'}` nodes need a distinct marker vs ordinary
  content nodes (likely: presence of a parent `defConfig`/value context).
- Undo granularity: a `fieldType` change + its `reconcileConfigSubtree`
  prune/create is one undo step.
