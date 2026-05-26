---
status: in-progress
priority: P1
owner: relixiaobo
created: 2026-05-26
updated: 2026-05-26
supersedes-framing: node-line-editor-unification.md#2b
---

# NodeLineEditor Extraction — Step 1 Design & Risk Assessment

> **Implemented (2026-05-26).** `TrailingInput` now renders the shared
> `RichTextEditor` over a local `RichText` buffer instead of running its own
> `EditorView`. `RichTextEditor` gained `onPasteCapture`, `linkifyPastedUrl`,
> and `className` (all inline-safe). The commit/projection-settle dance,
> depth-shift, options popover, and atomic trigger commands stayed in the
> wrapper; the three call sites are untouched (props interface preserved).
> typecheck clean; 503 unit tests pass. Behavior verification (commit/focus/
> IME/trigger) is pending the app + e2e — see the manual list below.

> **What changed.** The earlier "Phase 2b" framing assumed the elegant terminal
> state required a **real Loro draft node** materialized while typing in the
> trailing slot. That conflated two separable things — *one editing core* and
> *node lifecycle*. This document adopts the revised, lower-risk staging:
>
> - **Step 1 (this doc):** one editing core (`NodeLineEditor`) used by both real
>   rows and the trailing slot; the trailing slot keeps a **virtual, local
>   buffer** (no real node until commit). Eliminates the second ProseMirror
>   editor — which is the actual source of UI/interaction drift — without
>   touching the document model, undo grouping, persistence, projection, agent,
>   search, journal, or the existing e2e contracts.
> - **Deferred (separate future design):** any core-layer transient/draft-node
>   semantics. Only revisit if a concrete need proves it, and design the draft
>   marking / projection filtering / undo grouping / crash cleanup /
>   agent+search visibility *first*. See "Out of scope" below.

## Goal

A single ProseMirror editing core — `NodeLineEditor`, which **is today's
`RichTextEditor`** — rendered by both the inline row editor and the trailing
"new row" slot. "UI and interaction stay identical" becomes an architectural
guarantee (one editor) instead of hand-synchronization between two editors.

The trailing slot's only essential difference is **commit semantics** (create a
node vs. patch an existing one). That difference is expressed as injected
callbacks on the one editor, not as a second editor.

## Why this is now a safe extraction (grounding in the code)

| Fact | Evidence | Consequence |
|---|---|---|
| `RichTextEditor` is a controlled editor | props are `content` in, `onChange`/`onPatch`/`onCommit`/`onEnter`/… out (`RichTextEditor.tsx:50-90`); `nodeId` is an identity hint, not used to drive editing | It can be driven by a **local buffer** with no backing node — exactly what the trailing slot needs |
| Trigger popover self-captures keys | `TriggerPopover.tsx:117` adds a window **capture-phase** `keydown` listener for Arrow/Enter/Escape | The trailing slot reuses the same popover; arrow/enter navigation does **not** depend on the editor keymap → no conflict |
| The editing core is already extracted as pure logic | `nodeLineView.ts`, `nodeLineTrigger.ts`, `nodeLineKeymap.ts`, `clipboardPaste.ts` (PRs #11/#12/#14, all headless-tested) | The editor's internals are already shared and pinned by tests; step 1 wires the *one component* on top of them |
| Inline trigger application already lives outside the editor | `RichTextEditor` only emits `onTriggerChange`; `NodePanel.tsx:601-628` renders `TriggerPopover` and applies to the existing node | "Detection in the editor, application in the consumer" is the established pattern; the trailing slot keeps its own (atomic) application |

## Current state

Two independent `EditorView` instances render one node line:

- `RichTextEditor.tsx` (~715 lines) — edits an existing node. Controlled.
- `TrailingInput.tsx` (~1370 lines) — its own `EditorView` plus a local text
  buffer; on commit it **creates** a node. Duplicates paste, keymap, IME, focus,
  trigger detection — kept in sync by hand. This duplication is the drift source.

## Target architecture

```
NodeLineEditor  (= RichTextEditor, the single editing core)
  owns: EditorView lifecycle, pmSchema, paste plugin, keymap mechanics,
        trigger DETECTION (→ onTriggerChange), IME anchor, focus handshake,
        cursor placement, floating toolbar
  emits semantic callbacks: onChange / onPatch / onCommit /
        onEnter(split) / onBackspaceAtStart / onTab / onArrowUpAtStart /
        onArrowDownAtEnd / onShiftArrow / onModEnter / onEscape /
        onTriggerChange / onPasteOutliner / onPasteImage / onPasteMediaUrl /
        onFieldTriggerFire

  ├─ inline row editor (existing consumers: OutlinerItem, NodePanel)
  │     content   = node content
  │     onChange  = patch the existing node
  │     trigger   = parent renders TriggerPopover, applies to existing id
  │
  └─ TrailingSlot  (NEW thin wrapper, replaces TrailingInput's EditorView)
        content   = LOCAL buffer (RichText state) — no real node
        onChange  = setBuffer
        onCommit / onEnter = materialize via create commands (atomic)
        trigger   = wrapper renders the SAME TriggerPopover, applies via
                    the existing atomic create-and-apply commands
        owns the trailing-only surface (see below)
```

### What `TrailingSlot` owns (trailing-only; not editor concerns)

These move verbatim from `TrailingInput` into the wrapper — they are
create-semantics and field-value concerns, not editing concerns:

1. **Local buffer + synthetic focus target.** `content: RichText` state; a
   `focusTarget(effectiveParentId, …, 'trailing')` so focus requests route here.
2. **Effective-parent / depth-shift state** and the row's visual indent
   (`effectiveParentId`, `depthShift`, `setTrailingParent`, indent style).
3. **Commit → create mapping** (`commitContent`, `createContentAndContinuation`,
   `createDoneNode`, `createNodeAndFocusDescription`) including continue-on-enter.
4. **The projection-settle commit dance** (`eagerBufferRef`,
   `pendingCommittedVisual`, `beginProjectionClear`/`finishProjectionClear`,
   post-commit indent, `skipCreatedFocusAfterCommit` pointerdown listener,
   `refocusTrailingEditorSoon`). This is create-specific and stays whole.
5. **Trigger application — atomic, unchanged.** Wrapper renders `TriggerPopover`
   and applies via `onApplyTagTrigger`→`createTaggedNode`,
   `onCreateTagTrigger`→`createTagAndTaggedNode`,
   `onApplyReferenceTrigger`→`addReferenceConversion`/`createNodeWithContent`,
   `onExecuteSlashTrigger`. **No command changes**, so tests asserting "no
   `create_node`/`apply_tag` before commit" stay green.
6. **Options-field popover** (`PopoverListbox`) and its Arrow/Enter/Escape
   navigation — field-value context only.
7. **Structured/image/media paste → create** (`onCreateTree`, `onPasteImages`,
   `onPasteMediaUrl`), `create_field`, command palette.

### What the editor does for the slot (so the slot stops duplicating it)

- Paste front-matter classification (`classifyMediaPaste`) and parsing.
- Keymap mechanics: `resolveNodeLineKeyAction` → semantic callbacks.
- Trigger **detection**: `resolveNodeLineTrigger` → `onTriggerChange` (the slot
  renders the popover; the editor never owns popover UI).
- IME composition anchor + compositionend re-evaluation.
- Cursor placement + focus-request handshake.

## Callback semantic adaptation (the easy-to-underestimate points)

These are the spots where the editor's *edit* semantics must be adapted to the
slot's *create* semantics. Each is called out so it is not hand-waved.

1. **`onEnter` is a split, the slot wants the whole line.** The editor emits
   `EditorSplitPayload { before, after, atEnd }`. The slot commits
   `before + after` (the whole text). Today's trailing Enter-in-middle already
   commits the whole line; preserve that by concatenating, not by honoring the
   split point. If options are open, the slot's `onEnter` does `options_confirm`
   instead (the editor's keymap already yields a structural Enter; the slot
   branches on `optionsOpen`).
2. **Options-field key navigation has no home in the editor.** The editor keymap
   only knows Arrow/Backspace/Enter at boundaries. Resolve by **mirroring the
   `TriggerPopover` pattern**: the options `PopoverListbox` gets its own
   window capture-phase Arrow/Enter/Escape listener while open, so it intercepts
   before the editor — identical mechanism to triggers, no editor change needed.
3. **Boundary-only structural keys.** `resolveNodeLineKeyAction` fires
   `backspaceAtStart` / `navigateUp*` / `navigateDown*` only at doc boundaries;
   non-boundary Backspace/Arrow fall through to default editing. This already
   matches trailing's `allow_default` branch (`TrailingInput.tsx:1183`). Pinned
   by `nodeLineKeymap.test.ts`.
4. **Focus handshake + post-commit refocus.** The slot passes a synthetic
   `focusTarget`; the editor's existing `focusRequest`/`focusTarget` machinery
   drives the cursor. The post-commit refocus dance and the "user clicked
   elsewhere mid-commit" suppression stay wrapper-owned.
5. **`contentRevision`.** Real rows bump it to force external re-sync; the slot
   owns its buffer, so the wrapper manages revision (bump on parent change and
   after commit to clear the editor).
6. **Synthetic `nodeId`.** Pass a clearly namespaced sentinel (e.g.
   `trailing:${effectiveParentId}`) that is never persisted nor looked up in
   `index.byId`. (`nodeId` is an identity hint in `RichTextEditor`, not used to
   edit — confirm in 1a.)
7. **`create_field` detection** is shared (`resolveContentRowUpdateAction` →
   `onFieldTriggerFire`, already a prop). **Options-open detection** is
   field-value-specific and stays in the wrapper, derived from `onChange`.

### Deliberately preserved divergences (do not unify in step 1)

- **Single-line link URL**: inline linkifies; trailing lets it flow as text.
- **Marked single-line paste**: inline intercepts; trailing flows as text.

The slot opts out of these via paste flags so step 1 is behavior-preserving per
context. Reconcile later (tracked in `node-line-editor-unification.md`).

## Migration sub-steps (each independently typecheck/test-able)

- **1a. Make the core buffer-drivable.** Confirm `RichTextEditor` edits with a
  synthetic `nodeId`, an `onPatch` no-op, and `onChange`-only persistence. Add
  only the extension points the slot needs (paste opt-out flags; an
  options-popover capture hook if not modeled as a self-capturing popover).
  Expected: small or no change — it is already controlled.
- **1b. Build `TrailingSlot`.** Render `NodeLineEditor` over a local buffer;
  port the commit/projection-settle dance, depth-shift, options popover, and
  atomic trigger application **verbatim** from `TrailingInput`; adapt the
  semantic callbacks per the table above.
- **1c. Swap call sites** (`NodePanel`, `OutlinerItem`, `FieldValueOutliner`) to
  `TrailingSlot`; delete `TrailingInput`'s `EditorView` and its duplicated
  paste/keymap/IME/focus/trigger-detection code.
- **1d. Delete dead duplication** the shared core now subsumes.

## Risk assessment

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Commit / projection-settle dance regresses (`eagerBuffer`, `pendingCommittedVisual`, post-commit indent, Tab-while-committing) | Med | High | Port verbatim into the wrapper, keep the refs; cover with `outliner-trailing-expand`, `outliner-row-editing`; manual list below |
| R2 | Options-field keyboard nav drift | Med | Med | Mirror `TriggerPopover` self-capture; verify in `FieldValueOutliner`; manual test |
| R3 | IME composition in the buffer (trigger/options re-eval on `compositionend`) | Med | Med | Editor already handles IME; wrapper re-runs options-open on `onChange`/`onTriggerChange`; manual CJK test |
| R4 | Focus thrash / double-focus after commit (microtask+raf+timeout refocus, pointerdown suppression) | Med | High | Keep wrapper-owned and unchanged; manual "click elsewhere mid-commit" test |
| R5 | Accidentally unifying the paste thresholds changes behavior | Low | Med | Preserve via paste opt-out flags; the two divergences are explicitly deferred |
| R6 | Trigger application path changes (would break "no `create_node` before commit" e2e) | Low | High | **By design unchanged** — keep atomic `createTaggedNode`/etc.; `outliner-triggers` must stay green |
| R7 | Mounting the full editor (toolbar) for the slot adds cost/visual noise | Low | Low | Toolbar already suppressed with no selection/focus; verify empty-slot renders clean |
| R8 | Synthetic `nodeId` collides with focus model / inline-ref color resolver | Low | Med | Namespaced sentinel id, never persisted nor in `index.byId`; assert in 1a |
| R9 | Three call sites pass different prop subsets (panel title has no trailing; field-value adds options) | Med | Med | `TrailingSlot` props mirror `TrailingInput`'s current per-site usage exactly; no new required props |

**Net:** R1 and R4 are the real risks and they are *carried over unchanged*
(the dance is not rewritten, only relocated into the wrapper). R6 — the thing
that would change product semantics and break e2e — is explicitly avoided. This
is why the virtual-slot staging is materially safer than real draft nodes.

## Verification

- **Dev agent (this clone):** `bun run typecheck`, `bun test` (headless), and the
  existing shared-module unit tests (`nodeLineView`, `nodeLineTrigger`,
  `nodeLineKeymap`, `clipboardPaste`).
- **Main agent (app running):** e2e `outliner-triggers`,
  `outliner-paste-format`, `outliner-row-editing`, `outliner-trailing-expand`,
  `outliner-navigation-title`, `cursor-affordances`; plus the manual list.

### Manual test list (app running — cannot be verified headless)

1. Type in the trailing slot, Enter → node created, slot refocused empty.
2. Continue-on-enter context (where enabled): Enter creates content + empty
   continuation, focus lands on continuation.
3. Tab on empty slot indents (effective parent); Tab with text commits as
   indented child; Shift+Tab outdents; Backspace resets depth shift / collapses.
4. `#tag`, `@reference`, `/command` in the slot: popover navigates with
   Arrow/Enter; applying creates the node atomically (no orphan, no flicker).
5. Field-value slot: options popover opens on focus, Arrow/Enter selects,
   Escape closes; create-option path works.
6. CJK/IME: compose a trigger char and a tag query; commit; no lost text.
7. Click another row / toolbar mid-commit: no double node, no lost buffered keys
   (the `skipCreatedFocusAfterCommit` path).
8. Paste: image, remote image URL, structured multi-line, single plain line
   (must still flow into the slot as text), single link URL (still text in slot).
9. ArrowUp/Down at slot boundaries navigates out / to last visible descendant.
10. `Mod+Enter` (checkbox) and the description shortcut create the right node.

## Out of scope (deferred — separate future design if ever needed)

Real core-layer transient/draft nodes. They would collide with, and must each be
designed before adoption:

- `buildOutlinerRows` filtering / sorting / grouping (a draft row could jump or
  vanish under a filtered/sorted view).
- Undo grouping — `DocumentService` flushes non-text-patch commands, so a
  `create_node` on the first keystroke becomes its own undo group (orphan on
  undo).
- Persistence & visibility — every non-patch mutation saves the workspace and
  serializes Loro; a draft node is visible to projection, agent context, search,
  and operation history unless core adds transient semantics.
- Trigger commands would change from atomic create-and-apply to
  create→delTrigger→applyTag, altering commands, undo, journal, and the e2e
  assertions in R6.

Also deferred: paste-threshold reconciliation (link URL, marked single line) and
any field-value option-picker unification beyond keyboard-nav parity.

## Constraints

Built by the `lin-outliner-cc` dev agent: feature branch only, Draft PRs, no
merge / no push to `main` / no `docs/TASKS.md` edits. Inline-editor behavior
preservation and the manual list must be verified by the main agent running the
app. The `docs/plans/README.md` index entry needs the main agent to add it
(coordinated file).
