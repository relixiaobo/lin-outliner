---
status: in-progress
priority: P1
owner: relixiaobo
created: 2026-05-25
updated: 2026-05-25
---

# Node-line Editor Unification

> **Progress.** Phase 1 shipped (PR #11): a shared `classifyMediaPaste` helper
> classifies the media/URL front-matter of a paste for both editors.
>
> Phase 2a in progress (branch `cc/node-line-editor-core`): a shared
> `src/renderer/ui/editor/nodeLineView.ts` now owns the view helpers both
> editors had duplicated — `caretAnchor`, `selectionTextOffsets`, and a unified
> `selectionForPlacement` / `applyCursorPlacement` for resolving a
> `CursorPlacement` on the single-paragraph node-line doc. `RichTextEditor` and
> `TrailingInput` both delegate to it (the trailing input's bespoke
> `setTrailingSelection` and its inline-ref-blind `1 + offset` math are gone;
> the shared inline-ref-aware version reduces to the same thing for plain text,
> pinned by `tests/renderer/nodeLineView.test.ts`).

A node line — one editable line of node text — is rendered by **two
independent ProseMirror `EditorView` instances**:

- `src/renderer/ui/editor/RichTextEditor.tsx` (~800 lines) — edits an
  **existing** node's text.
- `src/renderer/ui/outliner/TrailingInput.tsx` (~1400 lines) — the blank line
  that, on commit, **creates a new** node.

They share only `pmSchema`. Every interaction (paste, keymap, slash/tag/
reference triggers, IME, focus handshake) is implemented twice and kept in
sync by hand. Nothing — no shared type, no test — forces them to agree, so
they drift: a feature added to one is silently missing from the other.
Observed drift includes the remote-URL paste bug (handled inline, not in the
trailing row) and a single-line marked paste (`**bold**`) being intercepted
inline but flowing as literal text in the trailing input.

## Thesis

The two editors **should be identical in UI and interaction**. Their only
essential difference is **commit semantics**, which collapses to a single
injection point:

```ts
interface NodeLineTarget {
  // inline editor: returns the existing node id (identity)
  // trailing input: creates the node once on first mutation, returns the new id
  resolveTargetId(): Promise<NodeId>;
}
```

Once a target id is resolved, every downstream mutation — set text, apply a
`#tag`, apply a reference, run a `/command`, toggle done, indent, paste a
structured subtree — operates on that id. The trailing input's ~10 bespoke
`onCreate*` / `onApply*Trigger` props collapse into the same command set the
inline editor uses, wrapped by a "materialize the node first" step.

## Target architecture

A `useNodeLineEditor` hook (or `<NodeLineEditor>` base) that **solely owns**:

- the `EditorView` lifecycle + `pmSchema`
- the paste plugin (delegating to shared intent classifiers)
- the keymap (Enter / Backspace / Tab / Arrows / Esc / Mod+Enter → semantic
  intents)
- trigger detection (`/`, `#`, reference → one `Trigger | null`)
- IME composition and the focus-request handshake

Consumers inject only a `NodeLineTarget` and a shared command-callback set:

- `TrailingInput` = core + `resolveTargetId = create-and-return new node`
- inline editor = core + `resolveTargetId = return existing id`

"UI and interaction stay identical" then becomes an architectural guarantee
rather than manual synchronization.

## Phases (each an independent Draft PR)

| Phase | Content | Risk |
|-------|---------|------|
| **1. Shared paste classifier** ✅ | `classifyMediaPaste` for the image / media-URL / link-URL front-matter; both editors call it. Behavior-preserving. | low |
| **2a. Shared view helpers** ✅ | `nodeLineView.ts`: `caretAnchor`, `selectionTextOffsets`, unified `selectionForPlacement` / `applyCursorPlacement`. Both editors delegate. Behavior-preserving (equivalence pinned by headless unit tests). | low |
| **2b. `useNodeLineEditor` core + `resolveTargetId`** | Build the view + plugins + keymap + trigger pipeline + IME + focus once; both editors become thin wrappers. Includes unifying trigger detection (see finding below) and routing trigger application through `resolveTargetId`, deleting the trailing input's bespoke `onApply*Trigger` props. The large, high-risk PR. | high |

### Finding: trigger detection is not a safe standalone extraction

The original plan had a separate low-risk "unify trigger detection" phase. On
inspection that is wrong — the two trigger systems are different *designs*, not
drifted duplicates:

| | inline (`RichTextEditor`) | trailing (`TrailingInput`) |
|---|---|---|
| detection | cursor-aware (`resolveEditorTriggerText`, looks around `cursorOffset`) | whole-text (`resolveTrailingRowUpdateAction` + `lastIndexOf`) |
| popover UI | delegated up to `NodePanel` via `onTriggerChange` (detection only) | owns its own `TriggerPopover` |
| application | done by the parent | done in-component, with create-node-first semantics |
| extra scope | — | option-fields, `create_field` (inline has neither) |

The only literally-duplicated module-level helper is `caretAnchor`. So there
is **no safe middle ground** between Phase 1 and the core: unifying triggers
*is* the core rewrite (a behavior reconciliation, not a mechanical extraction),
and must be verified with the app running.

### Safety net

Behavior preservation for Phase 2 is covered by existing Playwright e2e specs —
`outliner-triggers`, `outliner-paste-format`, `outliner-row-editing`,
`outliner-trailing-expand`. These run against a built app (main agent / CI),
not the dev agent's `bun test`.

### Staging decision (2026-05-25)

Paused after Phase 1. Phase 1 (PR #11) is a clean, self-contained, independently
mergeable win. Phase 2 is deferred until PR #10 (media URL sources) and PR #11
merge to `main` — to avoid a three-deep branch stack — and until the main agent
can run e2e + visually verify, since the dev agent cannot. Resume by branching
fresh from `main` for the core rewrite.

## Known divergences to reconcile (deliberate, deferred)

- **Single-line link URL.** The inline editor linkifies a lone pasted URL; the
  trailing input lets it flow in as text. Phase 1 preserves this (trailing
  ignores the `linkUrl` intent). Unifying = act on `linkUrl` in both.
- **Marked single-line paste.** `isPlainSingleParagraph` treats a single line
  with marks as structured (inline intercepts) but the trailing input's
  threshold ignores marks. Reconcile when the structured path is shared.

## Constraints

Built by the `lin-outliner-cc` dev agent: feature branch only, Draft PRs, no
merge / no push to `main` / no `docs/TASKS.md` edits. Behavior preservation on
the inline editor must be verified by the main agent running the app (the dev
agent cannot do visual verification). The `docs/plans/README.md` index entry
for this plan needs the main agent to add it (coordinated file).
