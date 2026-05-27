---
status: meta
priority: —
owner: relixiaobo
created: 2026-05-25
updated: 2026-05-25
---

# nodex Parity Decisions

A catalog of nodex features that lin **will not** port, plus the reason.
Companion to the active plans, which list what we **will** do.

This document is a forward-looking decision log. It is not a status of the
current code (for that see [`../spec/outliner-parity-matrix.md`](../spec/outliner-parity-matrix.md)).

## Already in lin (no action needed)

The first comparison pass missed these. Recorded here so we don't accidentally
re-plan them:

- **Zoom-in by bullet click** — `OutlinerItem.tsx:769` (`onDrillDown`).
- **Breadcrumb with collapsed ancestors** — `NodePanel.tsx:124` plus the
  `panel-breadcrumb-*` CSS in `src/renderer/styles.css`.
- **Floating mark toolbar** — `FloatingEditorToolbar.tsx`. Polish in
  [`floating-toolbar-polish.md`](floating-toolbar-polish.md), not a rebuild.

## Explicitly skipping

| nodex feature | Reason for skipping |
| --- | --- |
| Multi-panel side-by-side (nodex `Panel` + `NavigationEvent`) | lin's workspace tab + WorkspaceCanvas covers the same ergonomic with a different shape. Adding side-by-side later is a tab-system enhancement, not an outliner change. |
| `viewMode: 'tiles'`, `viewMode: 'navigationList'` | `list` + `cards` + `table` + `calendar` already covers the use cases. Tile/navigationList variants add UI surface for a small payoff. Reconsider only on user request. |
| Inline chat / agent message panel inside the document | lin runs agents through a separate dock (`AgentDock.tsx`) with a real provider runtime. Bringing chat back into the document blurs the outliner/agent boundary we deliberately drew. |
| `JOURNAL` system node + journal date-nav UI | Replaced by `DAILY_NOTES_ID` and `PanelDateNavigation.tsx`. Different concept, same coverage. |
| `CLIPS` web-clip system node + content-script highlight pipeline | Local app, not a browser extension. Page capture is out of scope; if it returns, it returns as a separate plan. |
| Tana import (nodex `services/tana-import.ts`) | No active user demand. Reconsider if a real migration request appears. |
| `Filter` rules as child nodes of `viewDef` | lin keeps **view** config typed (filter fields with typed enums), now on the dedicated `FilterRuleNode` union variant rather than the god-record (PR #18, A-full). Note: **definition** config (tag/field knobs) *did* move to child nodes as of PR #18 (`defConfig` subtrees) — config-as-nodes reverses this decision for definition config only; view config stays typed. |
| Chat panel as workspace panel kind (`isChatPanel`, `CHAT_PANEL_PREFIX`) | Same reason as "inline chat". |
| Wider trigger characters (`>` for create-field, `!` actions, `[[` wikilink) | Only `>`/`#`/`@`/`/` are in lin today. Open to per-trigger additions if a real workflow needs them, but no blanket parity. |
| Sync (`stores/sync-store.ts`) | lin is single-device today. Sync is a separate large plan, not nodex parity. |
| `EDIT_MODE`, `flags`, `publishedAt`, `searchableWhenLocked` node fields | Vestigial in nodex (`@deprecated` or unused in modern code paths). Not porting. |

## Reconsider list (low confidence, may flip)

| nodex feature | Why we might want it later |
| --- | --- |
| Per-tag color swatch picker as separate component (`ColorSwatchPicker.tsx`) | Currently inlined in `OutlinerFieldRow.tsx`. If we touch tag config UI for other reasons, factor it out. |
| `AutoCollectSection.tsx` / `AutoInitGroup.tsx` as distinct field config panels | Their lin equivalents are folded into `DefinitionConfigPanel.tsx`. If that panel grows past ~600 lines, split along these lines. |
| Field validation panel (`field-validation.tsx`) | When lin gains stricter field validation, follow nodex's separation. |

## Deliberate supersets (lin > nodex)

Things lin has that nodex does not, kept here so the asymmetry is visible:

- Typed enum unions for `FieldType / HideFieldMode / FilterOperator /
  DisplayPlacement / AutoInitStrategy / FilterValueLogic`.
- `RichText` container + `RichTextPatchOp` patch operations for CRDT-friendly
  text mutation.
- Batch operations: `batch_indent_nodes`, `batch_outdent_nodes`,
  `batch_toggle_done`, `batch_cycle_done_state`, `batch_duplicate_nodes`,
  `batch_move_nodes_up`, `batch_move_nodes_down`, `batch_apply_tag`,
  `batch_trash_nodes`.
- `DisplayPlacement` (`title` / `body` / `footer` / `hidden`) for per-display
  field placement in card and table views.
- `trashedFromParentId / trashedFromIndex` for restore-to-origin from trash.
- `inlineRefBias` cursor positioning when adjacent to an inline reference.
- Wider query operator set: `DATE_OVERLAPS`, `DESCENDANT_OF*`,
  `GRANDPARENTS_DESCENDANTS*`, `SIBLING_NAMED`, `HAS_AUDIO/VIDEO/IMAGE`,
  `FIELD_IS_SET / FIELD_IS_NOT_SET / FIELD_IS_DEFINED / FIELD_IS_NOT_DEFINED`.
- Command-driven core with `CommandOutcome { projection, focus? }`.
- Scoped `UndoManager` separating `user:` / `agent:` / `system:` origins.
- Agent runtime with pi-mono, skills, subagents, event-sourced sessions.
- Operation journal (`src/core/operationJournal.ts`).
- Generic file attachments (see [`file-attachments.md`](file-attachments.md)) —
  not yet shipped, but planned, and out of reach for a browser extension.

## Maintenance

- Update when a decision flips (move a row between sections, document
  the date and reason).
- Do not turn this into a feature spec. It only records *whether* we will do
  the thing; the *how* belongs in its own plan.
