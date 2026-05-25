---
status: in-progress
priority: P1
owner: relixiaobo
created: 2026-05-25
updated: 2026-05-25
---

# Node-line Editor Unification

> **Progress (branch `cc/node-line-editor-unification`).** Phase 1 shipped: a
> shared `classifyMediaPaste` helper (`src/renderer/ui/interactions/clipboardPaste.ts`)
> now classifies the media/URL front-matter of a paste for both editors;
> `RichTextEditor` and `TrailingInput` call it instead of each detecting image
> files / image URLs / link URLs themselves.

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
| **0. Characterization tests** | Pin current paste/keymap/trigger behavior of both editors before changing code, as proof the refactor preserves behavior. | none |
| **1. Shared paste classifier** ✅ | `classifyMediaPaste` for the image / media-URL / link-URL front-matter; both editors call it. Behavior-preserving. | low |
| **2. Unify trigger detection** | Extract `/` `#` reference detection into one module emitting a single `Trigger`; application unchanged for now. | low–med |
| **3. `useNodeLineEditor` core + `resolveTargetId`** | Build the view + plugins + IME + focus once; both editors become thin wrappers. The large PR — lands after 1+2 shrink the surface. | high |
| **4. Collapse trigger application** | Route trigger application through `resolveTargetId`; delete the trailing input's bespoke `onApply*Trigger` props. | med |

Order: shrink the surface (1, 2) → swap the skeleton (3) → clean up (4); low
risk before high; guard the inline editor (highest-traffic path) most.

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
