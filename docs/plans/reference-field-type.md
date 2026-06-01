---
status: in-progress
priority: P2
owner: relixiaobo
created: 2026-06-01
updated: 2026-06-01
---

# Reference field values: one reference-node model, two container modes

## Motivation

A field value that points at another node currently has two unrelated shapes:

- **Editable node values** (e.g. an `options` field's selected value) are real
  `reference` child nodes, rendered through the nested `OutlinerView` as
  reference rows — so they already support reference-node behavior: double-click
  edits the target, the row expands to show the target's children.
- **Read-only system node fields** (`References` = `sys:refCount` backlinks,
  `Owner` = parent, `Day` = nearest `day` ancestor) are *computed* and rendered
  by `SystemFieldValue` as **inert text links** (`.field-value-link`). They are
  neither editable-through-the-reference nor expandable, and visually read as
  grey plain text.

The user's intent (verbatim): a reference value should *be* a reference node —
double-clicking edits it (the change flows to the original node), and it can be
expanded to view it — **but** for a read-only field like `References` you must
not be able to add, delete, or otherwise restructure the value set, because that
set is computed and follows the document automatically.

That reconciles into a single clean model: **the reference node is always
full-featured; only the value *container* differs** (read-only vs editable).

## Goal

One reference-node presentation for every node-reference field value, reusing
the existing outliner reference-row path (double-click edits target; expandable).
Two container modes layered on top:

1. **Read-only / computed** — `References`, `Owner`, `Day`. Values are
   **projection-synthesized** read-only reference nodes (decision **A** below),
   derived from `core/systemFields.resolveSystemField` (already in core after the
   `system-field-followups` work). The container forbids add / delete / reorder;
   the set auto-follows the document.
2. **Editable** — a new `reference` **field type**. The user `@`-picks any node;
   the value is stored as a real `reference` child of the field entry; add /
   delete allowed. Same reference-row rendering as (1).

This deletes the bespoke `.field-value-link` style: node-reference values render
like references everywhere else, exactly as the `Tags` system field already
reuses the inline `.tag-badge` chip.

## Non-goals

- Not changing backlink / parent / day computation semantics — only how their
  results are surfaced.
- No reference *target* type constraint (a reference field points at any node;
  no "only nodes tagged X" filter — that is a later refinement if wanted).
- Not touching `Tags` (already reuses `.tag-badge`) or the date / number / url /
  email / checkbox value paths.
- Not asset/image/embed reference work.

## Design

### Decision A (locked): computed fields synthesize read-only references

For the read-only system fields, read-only `reference` child nodes are
synthesized under the system field entry, pointing at the resolved source nodes
(backlink sources / parent / day). They are **not persisted** — purely derived
from `resolveSystemField`, so they auto-follow the document and never pollute the
stored tree.

**Synthesis happens render-time (renderer row model), not in core's
`DocumentProjection`.** Rationale: `References` is a global *reverse* index —
adding a reference on node X changes the synthetic children of node Y (the
target). Core's projection is an incremental per-touched-node cache (perf
refactor #28); injecting a reverse-index there needs cross-node invalidation that
fights that cache. The renderer already computes these values at render time via
`resolveSystemField` over the full `byId`, so it synthesizes the read-only
reference node projections into an augmented index for the field-value subtree —
the same place the values are computed today, just promoted from inert links to
real reference rows. Core stays untouched for the read-only path; only the new
editable `reference` field type (Part C) adds core/protocol surface.

Rejected alternative (B): core materializing real stored reference children and
syncing them to the backlink set on every reference change — heavier, writes to
the document, contradicts the "computed" nature, and fights the incremental cache.

### Container modes

| | `References` / `Owner` / `Day` (read-only) | `reference` field type (editable) |
| --- | --- | --- |
| Value source | computed (`resolveSystemField`) | user `@`-picks a node |
| Stored? | no (projection-synthesized) | yes (`reference` child node) |
| Add / delete value | ✗ locked | ✓ |
| Edit target (double-click) | ✓ | ✓ |
| Expand to view target | ✓ | ✓ |
| Cardinality | `Owner`/`Day` single, `References` many | many (append; no cardinality gate) |

### Rendering

Route node-reference system fields through the same nested-`OutlinerView`
reference-row path the editable node values already use, instead of
`SystemFieldValue`'s inert links. `SystemFieldValue` keeps only the non-node
kinds (dates, the Done checkbox; `Tags` stays on its badge path). The read-only
container suppresses the trailing draft row and per-row delete/structure ops.

### The `reference` field type (editable)

- **core / protocol**: `FieldType` gains `'reference'`; a command to set/append a
  reference value on an entry (a generalization of `select_field_option` whose
  target is any node rather than a pool option). Config has no option pool / no
  autocollect.
- **renderer registry**: `reference → interaction: 'referencePicker'` (new
  `FieldValueInteraction`); `fieldValueEditor` descriptor for it.
- **picker**: reuse the existing `@` reference type-ahead / node-search infra; in
  a reference field's value row, typing opens node search directly (no `@`
  prefix needed, since the whole field is references). Selecting creates the
  reference value node.

## Open questions / to resolve in implementation

- **Synthetic-node plumbing.** (Location resolved: render-time, see Decision A.)
  Remaining: the exact seam for the augmented index over the field-value subtree
  (synthetic reference `NodeProjection`s + the entry's `children` pointing at
  them) and how they are flagged so (a) the renderer offers no edit/delete and
  (b) any stray command targeting a synthetic id fails closed. Likely a synthetic
  id prefix + the synthetic refs / entry carrying `locked`.
- **Read-only OutlinerView mode.** `FieldValueOutliner` today only mounts when an
  editable `optionField` is present; needs a read-only variant (no `trailingDraft`,
  no delete) for the computed fields — confirm the smallest seam in
  `OutlinerView` / `OutlinerItem`.
- **Owner/Day single-value affordance.** Confirm a single read-only reference row
  reads well in the value cell (vs the current one-line link).

## Implementation checklist

1. **Core projection synthesis** — synthesize read-only reference children for
   `References` / `Owner` / `Day` from `resolveSystemField`; mark read-only.
   Equivalence test: synthesized set == `resolveSystemField` result.
2. **Renderer read-only reference rows** — render those via the reference-row
   path; lock container (no trailing draft, no delete); delete `.field-value-link`;
   keep dates/checkbox/Tags as-is.
3. **`reference` field type — core** — `FieldType += 'reference'`; set/append/remove
   reference-value command(s); config projection (no pool/autocollect).
4. **`reference` field type — renderer** — registry interaction + descriptor; the
   `@` node picker in the value row; editable container wiring.
5. **Tests** — core (synthesis equivalence; set/append/remove reference value);
   renderer (descriptor, picker, read-only vs editable container); e2e (References
   renders expandable read-only reference rows that can't be added/deleted; a
   `reference` field lets you `@`-pick and remove a node).
6. **Docs** — fold into `spec/` (field types + `ui-behavior.md`), flip status.

## Coordination

Touches the protocol surface: `src/core/types.ts` (`FieldType`) and
`src/core/commands.ts` (a reference-value command) — coordinated, isolated
changes. Branch `cc/reference-field-type`, stacked on `cc/system-field-followups`
(this work consumes FU1's `core/systemFields.resolveSystemField`); rebase onto
`main` once the followups PR merges.
