---
status: done
priority: P2
owner: relixiaobo
created: 2026-06-01
updated: 2026-06-02
---

> **Shipped in PR #70 (2026-06-02).** Field-name reuse + read-only system fields +
> trailing-draft Tab relocate. Kept as historical context.

# Field-name reuse + read-only system fields

## Motivation

Today `>` always mints a brand-new, empty `fieldDef` (`create_inline_field`).
Two fields named "Status" on two nodes are two unrelated definitions. Tana's
interaction is different: after `>` you type the field name and a popover offers
**fields you already created** (plus built-in **system fields**) so you can
*reuse* one definition instead of forking a new one.

This plan adds that reuse popover and, per the agreed v1 scope, also surfaces the
read-only **system fields** the app already models for views
(`collectViewFieldChoices`): Created / Last edited / Done / Done time / Tags /
References. Field-**type** templates (Date/Number/Checkbox as types) are out of
scope ("不包括类型").

## Model decisions

- **Reuse a user field = relink, not re-create.** `>` keeps minting a draft
  `fieldDef`+entry (the name input edits the draft's text, unchanged). When the
  user picks an existing field, a new core command repoints the entry's
  `fieldDefId` to the chosen def and deletes the now-orphaned draft def. This
  keeps the existing `>` / name-edit flow intact and avoids a deeper "defer def
  creation" refactor.
- **A system field is the entry pointing at an existing `sys:*` id**, the same
  synthetic ids the view layer already uses (`sys:createdAt` … `sys:refCount`).
  These are NOT nodes — but the only core paths that dereference `fieldDefId` are
  options/promote flows, which read-only fields never reach, and projection /
  normalize treat the id as opaque data (`projectFieldTypeById` returns
  `undefined` gracefully). Verified there is no global "every `fieldDefId`
  resolves" invariant, so the sentinel is safe and avoids a second parallel
  system-field model. `reuse_field_definition` accepts a `sys:*` target without
  requiring a node; everything else still requires a real def.
- **A system field's value is computed, not stored.** The entry has no value
  child nodes; the renderer detects a `sys:*` `fieldDefId`, renders a fixed
  read-only name (`fieldChoiceLabel`) and a read-only computed value
  (`systemFieldDisplayValue`, reusing the view layer's `fieldValuesFor`), and
  suppresses the editable value outliner / trailing draft. No `systemKind` config
  key, no seeded def nodes, no `configSchema`/`types.ts` change.

## Stages

1. **Core: relink command + orphan cleanup.** `reuse_field_definition(entryId,
   targetDefId)`: validate `entryId` is a `fieldEntry`; capture the old
   `fieldDefId`; repoint to `targetDefId`; if the old def is now unreferenced and
   is a plain user `fieldDef` under `SCHEMA_ID`, remove its subtree. IPC wiring
   (`commands.ts`, `documentService.ts`, `api/client.ts`, `api/types.ts`). Core
   tests: relink drops the orphan draft; relink to an already-referenced def does
   not delete it; relinking onto a still-referenced source is a no-delete.
2. **Renderer: reuse popover on the field-name input.** While editing a field's
   name, show an anchored popover of candidates filtered by the typed text
   (existing user `fieldDef`s; system fields once stage 3 lands). Keyboard nav via
   the shared `menuNavigation` helpers. Select → `api.reuseFieldDefinition`. e2e.
3. **System fields (read-only computed).** `reuse_field_definition` accepts a
   `sys:*` target (no node required). Renderer: a `sys:*` `fieldDefId` renders a
   static read-only name + a computed read-only value (suppress the editable
   value outliner / trailing draft); the popover gains a "System fields" section.
   Tests (core + renderer + e2e). No config-schema change.
4. **Verify + spec.** `typecheck`, core/renderer/e2e suites; fold the behavior
   into `docs/spec/` (`commands.md`, `ui-behavior.md`). Open the PR; flag the
   protocol-surface addition (`commands.ts`) for main-agent coordination.

## Coordination

Only one protocol-surface file is touched: `src/core/commands.ts` (one additive
command). `types.ts` and `configSchema.ts` are untouched. Flagged here and in the
PR body so the main agent / sibling clones can rebase.

## Post-review refinements (user testing)

Three issues surfaced when the user exercised the feature; all addressed on this
branch:

- **Space summons the picker.** `Space` on an *empty* field name opens the full
  reuse picker (all user fields + system fields, alphabetical) instead of typing a
  leading space — mirrors the field-value pickers' "Space to open" affordance.
  Once the name has text, `Space` types normally.
- **No duplicate fields per node.** Reuse candidates now exclude any field already
  present on the same owner node (a node may not carry the same field twice), for
  both user and system fields — so the duplicate can't be selected. Reuse is
  therefore a cross-node gesture; the e2e reuse test was restructured to relink on
  a different node than the source.
- **`>` conversion responsiveness.** The reuse candidate scan is now memoized
  (`useMemo` keyed on the doc map / draft / focus), so the name-input focus burst
  that fires on a `>` conversion no longer repeats a full-document O(N) scan on
  every intermediate render. (The core command itself is already O(touched) via
  the incremental caches, and `createInlineFieldAfterNode` accepts an empty name,
  so the legacy retry path never runs.)

## Second-round refinements (system-field rendering)

- **`Done` is a read-write checkbox.** Other system fields stay read-only computed
  text, but `sys:done` is a projection of the owner node's *mutable* done state, so
  it renders as a checkbox; toggling it calls `toggle_done(ownerNode)`. `checked`
  is derived from the same `systemFieldDisplayValue` resolution (`'Done'`).
- **Field rows are not expandable.** A field entry's children *are* its value(s),
  rendered in the value column — there is no separate child scope. The leaf-expand
  chevron is suppressed on field rows via CSS (the bullet keeps its explicit
  `grid-column: 3`, so it still aligns with sibling content rows).
- **Relinking onto a system field drops stored value children.** A read-only
  system field's value is computed, never stored, so `reuseFieldDefinition` now
  removes any value children the draft entry carried (mirrors `clearFieldValue`),
  leaving the entry value-clean instead of orphaning hidden nodes.
- **System fields render by their real type, not bare text.** Audited all six
  against `ViewToolbar`'s `filterFieldKind` (the authoritative type map): besides
  `Done` (checkbox), `Created` / `Last edited` / `Done time` are dates (calendar
  glyph), `Tags` is a tag-reference list (colored badges), `References` is the
  backlink source nodes (navigable links, not a bare count). Centralized every
  rendering decision in one structured `systemFieldDisplay` helper (discriminated
  by `kind`) so the row component just switches on it.

## Tana parity: Owner + Day system fields

Added two more Tana-aligned read-only system fields, on-node only (renderer-side;
`ViewSystemField` / `types.ts` untouched — no protocol churn):

- **Owner** (`sys:owner`) — the owner's **parent node**, as a navigable link.
- **Day** (`sys:day`) — the date of the nearest `day`-tagged ancestor (the
  daily-note page the node lives under), with a calendar glyph, navigable.

Both flow through `systemFieldDisplay` (`nodeRefs` / `dayRef` kinds). Multiplayer
fields Tana has (`lastModifiedBy` / `modifiedBy`) are intentionally skipped — this
app is single-user local with no account model. View-config support for Owner/Day
(adding them to `ViewSystemField`) is a deliberate follow-up requiring protocol
coordination.

## Cleanliness refactor (post-implementation review)

A self-review flagged `OutlinerFieldRow.tsx` as overloaded (703 lines mixing the
reuse popover state machine, system-field rendering, name editing, and keyboard
handling). Split into focused units, no behavior change:

- **`SystemFieldValue.tsx`** — owns all read-only system-field value rendering (the
  `renderValue` switch + the `Done` checkbox). The row hands it the structured
  `SystemFieldDisplay`; it switches on `kind`.
- **`useFieldNameReuse.ts`** — owns the popover state machine (focus + the
  `typing`/`forced`/`dismissed` mode) and the memoized candidate scan, so the
  scattered resets that previously lived across `onFocus`/`onChange`/`onBlur`/
  `onKeyDown`/`onSelect`/`onOpenChange` can't drift out of sync.
- **Memoized `systemFieldDisplay`** — the row now memoizes the display so its
  focus/selection/popover re-renders don't repeat the owner scan (`References` is an
  O(N) backlink walk). Keyed on `byId`/`parentId`/`systemFieldId`.

`OutlinerFieldRow.tsx` drops to 572 lines; the two extracted files are 121 + 89.

### Bugfix: Done on a locked owner crashed on click

User report: clicking a `Done` field's checkbox errored with `operation is not
allowed on locked node: date:…`. The `>` trigger makes a field belong to the
current row's *parent*, so a Done field created at a daily-note page's root is owned
by the locked `date:` page; `toggle_done` rejects locked nodes. Fix: the Done
checkbox is interactive only when the owner is editable (`!owner.locked`); on a
locked owner it renders read-only (`SystemFieldValue` drops the `<button>` for an
inert `aria-disabled` span), reflecting state without attempting the toggle. The
owner's own row also shows a synced checkbox whenever a Done field is attached (see
the follow-up below) — the two-way sync the user expected.

The e2e mock's `today` date node was **unfaithful** (not locked), which is why the
prior Done-toggle e2e passed while the app crashed. The mock now locks `today` to
mirror core's `freshId('date')` + `locked: true`; the Done-toggle e2e moved to an
editable child (`gamma`), and a new e2e covers the locked-owner read-only case
(plus a `SystemFieldValue` unit test for the interactive-vs-read-only branch).

### Follow-ups (landed on `cc/system-field-followups`, separate PR — touches core)

Two items deferred out of #70 onto a core-touching branch, both now done:

1. **System-field derivation consolidated into core.** `nearestDayNode` and
   `backlinkSources` (formerly in `outlinerRows.ts`) re-derived in the renderer what
   core already computes. They now live in `src/core/systemFields.ts` as one
   `resolveSystemField` source that feeds sort/group (`systemFieldValues` → scalar
   strings) *and* rendering (`systemFieldDisplay` → the typed display union). The
   renderer constants/labels/`isSystemFieldId` are re-exported from there too, so
   there is a single home for the `sys:*` contract.
2. **A node carrying a Done field auto-shows a synced row checkbox.**
   `nodeShowsCheckbox` (in `configProjection.ts`) gained a third trigger:
   `nodeHasDoneField` — true when the node has a `sys:done` field entry child. The
   row checkbox and the Done field value both read the owner's `completedAt`, so they
   stay in sync with no extra wiring, and the box shows even before the first toggle.
   `DoneCheckbox` gained a `readOnly` mode (mirroring `SystemFieldValue`) for the
   locked-owner case (a Done field can reach a locked day page via a tag template),
   so the new row checkbox never re-introduces the locked-node `toggle_done` crash.

## Status

All four stages, the post-review refinements, the Tana-parity Owner/Day fields, and
the cleanliness refactor implemented and green: `typecheck` clean; renderer 255/255
(incl. 7 `systemFieldDisplay` unit tests); full `outliner-triggers` e2e 49/49 (incl.
Space-summon, per-node dedupe, Done checkbox, Tags badges, date glyph, Owner, Day).
Core suite unchanged (pre-existing `file_grep`/ripgrep env failures, unrelated).
Pending review + merge by the main agent.
