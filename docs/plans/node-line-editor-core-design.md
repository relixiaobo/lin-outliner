---
status: design
priority: P1
owner: relixiaobo
created: 2026-05-26
updated: 2026-05-26
---

# Node-line Editor Core — Implementation Design (Phase 2b)

This is the **build contract** for Phase 2b of
[`node-line-editor-unification.md`](node-line-editor-unification.md): the
`useNodeLineEditor` core + `resolveTargetId`. It is written so that whoever
implements it (and whoever runs the app to verify it) shares one picture.
Phases 1 (`classifyMediaPaste`, PR #11) and 2a (`nodeLineView.ts`, PR #12) are
done and assumed present.

> **Why a design first.** 2b is an atomic rewrite of the hottest editing path
> that cannot be verified by `bun test` (it needs real `EditorView` behavior:
> IME, `coordsAtPos`, dispatched keydowns, focus). The remaining surfaces —
> keymap, triggers, IME — are not duplicated code but two different *designs*
> (verified by reading both `handleKeyDown` and composition handlers in full).
> They only converge through the `resolveTargetId` reframing below.

## 1. What actually differs (the honest inventory)

Read of both editors as they stand:

| Surface | Inline (`RichTextEditor`, ~800 ln) | Trailing (`TrailingInput`, ~1400 ln) |
|---|---|---|
| Purpose | edit an **existing** node's text | buffer text; on commit **create** a node |
| Doc/position model | single-paragraph `pmSchema` | same (shared via `nodeLineView` since 2a) |
| Paste front-matter | `classifyMediaPaste` (shared since #11) | `classifyMediaPaste` (shared) |
| Caret / selection placement | `nodeLineView` (shared since #12) | `nodeLineView` (shared) |
| Keymap | inline-ref selection shortcuts, mark toggles, Enter→split, Backspace-at-start→merge, Tab→indent w/ cursor offset, arrows→nav, Esc | commit state machine (`committingRef` buffering), Enter→`resolveTrailingRowEnterIntent` (options/create/continue), Tab→commit-as-child or indent/outdent **effective parent**, Backspace→`resolveTrailingRowBackspaceIntent` (depth-shift/collapse/focus-last), arrows→options nav or navigate-out |
| Triggers | cursor-aware detect (`resolveEditorTriggerText`); **delegates** popover + application to `NodePanel` via `onTriggerChange` | whole-text detect (`resolveTrailingRowUpdateAction`+`lastIndexOf`); **owns** `TriggerPopover`; applies with create-node-first semantics; also option-fields + `create_field` |
| IME | rich: `compositionDocChangedRef`, `flushCompositionChanges`, `ensureImeCompositionAnchor` (inline-ref anchor), trigger suppression while composing | minimal: `composingRef` set/clear + keydown guard |
| Commit | `onChange`/`onPatch`/`onCommit` on the existing node | `onCreate`/`onCreateTree` + post-create focus dance |

**Conclusion:** the core can own the *mechanical pipeline* (view lifecycle,
paste, caret/selection, the key→intent dispatch skeleton, trigger detection,
IME state, focus handshake). The *commands* genuinely differ and must be
**injected**, not flattened into one shape. "Both become thin wrappers" means
*thinner* wrappers that inject a target + a command set — not zero-logic.

### Revision after reading both editors end-to-end (2026-05-26)

A full read of both components changes the recommendation on the *form* of the
core. RichTextEditor is ~90% inline-specific imperative wiring (the floating
mark toolbar, inline-reference click/anchor/IME, content-revision sync,
pending-input insertion, field-trigger); TrailingInput is a create/buffer/
async-commit state machine with option-field UI. The genuinely shared surface
is the **pure decision logic** — and that is now *entirely* extracted into
shared modules:

- `interactions/clipboardPaste.ts` (`classifyMediaPaste`, PR #11)
- `editor/nodeLineView.ts` (caret + selection placement, PR #12)
- `editor/nodeLineTrigger.ts` (`resolveNodeLineTrigger`, this branch)
- `interactions/nodeLineKeymap.ts` (`resolveNodeLineKeyAction`, this branch)

Given that, a monolithic `useNodeLineEditor` hook that both editors consume as
"thin wrappers" is **not worth building**: it would be a thin `new EditorView`
+ cleanup shell wrapped by dozens of injection points around two essentially
different machines (create vs. edit), and prevents only *skeleton* drift — while
the *behavioral* drift (what each key/trigger does) is already prevented by the
shared pure modules above. The cost (a large, blind, hot-path relocation) far
exceeds the marginal benefit. **Recommendation: drop the hook.** The "core" is
the set of shared pure modules, not a class/hook.

### The remaining unification, and why it needs the app

The one substantive piece left is the design's thesis — **trigger application
through `resolveTargetId`** so `#`/`@`/`/` behave identically. It is *not* a
mechanical extraction: it is a multi-file rewrite of the trailing input's async
create machinery —

- `beginInlineTriggerCommit` / `finishInlineTriggerCommit` (the `committingRef`
  + projection-clear + focus-restore dance),
- `applyTrailingTag` / `createTrailingTag` / `applyTrailingReference`
  (including the reference inline-conversion + pending-text handoff,
  `TrailingInput.tsx` ~695–745) / `executeTrailingSlashCommand`,
- the bespoke `onApply*Trigger` props implemented in `NodePanel`,
  `OutlinerItem`, `FieldValueOutliner`,
- and consolidating the trailing-owned `TriggerPopover` onto `NodePanel`.

This is the hottest node-creation path; the async/focus/undo-grouping behavior
is not headlessly testable and must be verified in-app step by step. It should
be done with the app in the loop (run → adjust), not as a blind rewrite — a
broken async rewrite here cannot be diagnosed without reproducing it.

## 2. The central abstraction

```ts
// One node line operates against a target. The only essential difference
// between the two editors is how the target id comes to exist.
interface NodeLineTarget {
  /** Inline: the existing node id (identity, sync). Trailing: create the node
   *  once on first mutation and return its id (memoized for the line's life). */
  resolveTargetId(): Promise<NodeId>;
  /** Trailing is transient: its content is a buffer that resets after commit
   *  and the row may re-home under an "effective parent". Inline is durable. */
  readonly transient: boolean;
}
```

`resolveTargetId` is **not independently useful** — its payoff only lands when
a shared core routes the command set through it. That is why 2b is atomic and
2a was the last separately-shippable slice.

## 3. The shared command vocabulary

Everything a node line can do, keyed off a resolved node id. The inline editor
implements these directly against its node; the trailing input implements each
as `resolveTargetId()` → same call. Target-specific behaviors stay as separate,
optional hooks (they are not shared and should not be forced to be).

```ts
interface NodeLineCommands {
  // text lifecycle
  onTextChange(content: RichText): void;          // inline onChange; trailing buffer update
  onTextPatch(patch: RichTextPatch): void;        // inline onPatch; trailing no-op until commit
  onCommit(content: RichText): void;              // inline onCommit; trailing create-or-update

  // structural intents (already pure-resolved per editor; see §4)
  onSplit(payload: EditorSplitPayload): void;     // Enter
  onBackspaceAtStart(isEmpty: boolean): void;     // Backspace at offset 0
  onIndent(shiftKey: boolean, cursorOffset: number): void; // Tab
  onNavigate(direction: 'up' | 'down', edge: 'start' | 'end'): void; // arrows at boundary
  onMove?(direction: 'up' | 'down'): void;        // mod+shift+arrow
  onToggleDone(content: RichText): void;          // checkbox shortcut
  onToggleDescription?(payload: { cursorOffset: number }): void;
  onEscape(): void;

  // trigger application — the part that currently differs most (see §5)
  applyTrigger(trigger: EditorTrigger, query: string): Promise<void> | void;

  // paste (structured; media/url already classified by classifyMediaPaste)
  onPasteStructured(payload: PasteStructuredPayload): void;

  // history
  onUndo?(): void;
  onRedo?(): void;
}
```

Target-specific (injected, **not** in the shared interface):
- Inline only: inline-reference selection shortcuts (`resolveSelectedReferenceShortcut`), `onInlineReferenceClick`, mark toggles.
- Trailing only: options-field flow (`onSelectOption`/`onCreateOption`), `create_field`, effective-parent depth-shift (indent/outdent the re-homed parent), `onNavigateOut`, the post-commit focus/eager-buffer dance.

## 4. `useNodeLineEditor` hook

```ts
interface UseNodeLineEditorArgs {
  mount: HTMLElement | null;
  target: NodeLineTarget;
  commands: NodeLineCommands;
  initialContent: RichText;             // inline: node content; trailing: EMPTY_RICH_TEXT
  focusRequest?: FocusRequest;
  focusTarget?: FocusTarget;
  resolveInlineReferenceColor?: (id: string) => string | undefined;
  readOnly?: boolean;
  // injected, editor-specific extensions:
  keymapExtensions?: NodeLineKeymapEntry[];   // inline-ref shortcuts, marks, options nav…
  onTrigger?: (trigger: EditorTrigger | null) => void; // inline delegates up; trailing self-owns
}

interface UseNodeLineEditorResult {
  view: EditorView | null;
  // imperative helpers the wrapper still needs (focus, reset, etc.)
}
```

The hook owns, once:
- `new EditorView` + `EditorState` init (initial selection via `nodeLineView.selectionForPlacement`).
- `editorProps.handleKeyDown`: the **shared skeleton** — IME guard
  (`isImeComposingEvent || composing`), undo/redo (`matchesShortcutEvent`),
  then run `keymapExtensions` (editor-specific) before the shared
  Enter/Backspace/Tab/Arrow/Esc dispatch that calls `commands.*`.
- `editorProps.handlePaste`: media via `classifyMediaPaste` (shared), structured
  via `parseClipboardPaste` → `commands.onPasteStructured`.
- `dispatchTransaction`: text-change → `commands.onTextChange` (+ patch), trigger
  re-detect (§5), IME accounting.
- composition start/end with the shared `composing` flag; the inline-ref anchor
  (`ensureImeCompositionAnchor`) is an injected extension.
- the focus-request handshake (`focusTargetMatches` → focus + `applyCursorPlacement`).

## 5. Trigger pipeline (the crux)

Split detection from application:

- **Detection (shared, in the core):** on every doc change, compute
  `EditorTrigger | null` from the cursor + text. Today inline uses
  `resolveEditorTriggerText` (cursor-aware) and trailing uses
  `resolveTrailingRowUpdateAction` (whole-text). **Pick cursor-aware as the one
  truth** (it is the more correct model; whole-text + `lastIndexOf` is a
  simplification that holds only because the trailing line is short). This is a
  deliberate behavior change for the trailing input — gated by the
  `outliner-triggers` e2e spec.
- **Application (injected):** `commands.applyTrigger(trigger, query)`.
  - Inline: emit up via `onTrigger`; `NodePanel` drives the existing popover and
    applies against the existing node.
  - Trailing: `resolveTargetId()` (creates the node) → apply the tag/reference/
    slash against that id using the **same** application path the inline editor's
    `NodePanel` uses. This is what deletes `onApplyTagTrigger` /
    `onCreateTagTrigger` / `onApplyReferenceTrigger` / `onExecuteSlashTrigger`.
- **Popover ownership:** unify on `NodePanel` owning the `TriggerPopover` for
  both (the trailing input stops rendering its own). This is the largest
  behavioral consolidation and the highest-value one.

Options-field flow and `create_field` remain trailing-only injected behavior;
they are not triggers in the `#/@//` sense and should not be forced into the
shared pipeline.

## 6. Migration order (each step gated by named e2e specs)

1. **Core scaffold, inline first.** Build `useNodeLineEditor`; migrate
   `RichTextEditor` onto it with `resolveTargetId = identity`, `transient:false`.
   No behavior change intended. Gate: `outliner-row-editing`,
   `outliner-navigation-title`, `cursor-affordances`, `outliner-triggers`.
2. **Trailing onto the core, create-target.** Migrate `TrailingInput` with the
   create-and-memoize target; keep options/depth-shift/navigate-out as injected
   extensions. Gate: `outliner-trailing-expand`, `outliner-row-editing`.
3. **Unify trigger application + popover.** Route trailing triggers through
   `resolveTargetId` + the shared application; delete the bespoke
   `onApply*Trigger` props and the trailing-owned popover. Gate:
   `outliner-triggers`, `outliner-paste-format`.
4. **Reconcile the deferred divergences** (below).

Do inline first because it is the higher-traffic path: getting the core right
on it before layering the create-semantics avoids debugging both at once.

## 7. Deferred divergences to reconcile in 2b

- **Single-line link URL.** Inline linkifies a lone pasted URL; trailing lets it
  flow as text (Phase 1 preserved this by ignoring the `linkUrl` intent). Unify
  by acting on `linkUrl` in both.
- **Marked single-line paste.** `isPlainSingleParagraph` treats a single line
  with marks as structured (inline intercepts); the trailing threshold ignores
  marks. Unify when the structured paste path is shared.

## 8. Risks & verification

- Highest-risk areas: IME composition (especially inline-ref anchoring),
  trigger timing on doc change, the trailing commit/focus dance, and
  Backspace-at-start merge. None are unit-testable headlessly.
- Each migration step is its own PR, gated by the e2e specs named above, and
  must be run in-app by the main agent. Keep the inline-editor PR (step 1)
  reviewable in isolation before trailing lands.
- Headless unit tests still apply to the pure pieces: any new key→intent or
  trigger-detection resolver should be a pure function in `interactions/` with
  `bun test` coverage, mirroring `nodeLineView.test.ts` and `clipboardPaste.test.ts`.
