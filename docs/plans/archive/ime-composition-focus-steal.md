---
status: done
---

# IME composition hold + pendingInput handoff (issue #176)

Shape: **ONE complete feature in one PR.** Fixes the P1 bug where an in-flight
IME composition is force-committed mid-word (`skill` → `sk ill`). PM ratified
the direction on 2026-06-10 (issue #176) and approved this concrete design in
conversation.

Live verification on the real app exposed that the symptom has **two
independent root causes**, both fixed here:

1. **Focus steal** — a split echo's focusRequest moves focus mid-composition
   (the originally diagnosed leg). Fixed by the gate + handoff below.
2. **Empty-row paragraph redraw** — composing into an EMPTY textblock, the
   block has no #text node to host the IME's marked range; ProseMirror redraws
   the whole paragraph element on the first non-append composition rewrite
   (macOS Pinyin re-segmenting "s k" → "sk i" at the third letter) and the OS
   IME session dies with the removed node — force-commit + torn recompose,
   no focusRequest involved at all. PM repro: only empty rows tore; rows with
   existing text never did. Proven by a MutationObserver forensic trace
   (`childList removed: P` at composition update 3). Fixed by seeding the
   empty block with the zero-width sentinel anchor at composition start
   (`compositionAnchorTransaction`, extending the existing inline-ref anchor
   pattern), so the composition always has a stable #text node that PM patches
   in place.

## Goal

- An IME composition is **never aborted** by the system's own async echoes.
- Text composed immediately after Enter/split lands **whole, in the new row**
  (the row the user intended).
- The same hold protects every `focusRequest` application path (indent/outdent,
  undo-driven focus moves, row materialization), not just Enter/split.

## Non-goals

- **Optimistic local split.** It fixes latency, not corruption; its costs
  (client-generated node IDs = protocol change colliding with PR #175, or
  temp-ID rebind whose remount re-introduces composition aborts, echo
  reconciliation, command queueing against unmaterialized nodes) buy nothing
  the hold doesn't already deliver. Can be a later, IME-agnostic optimization
  (A9: measure first).
- **ASCII fast-type stranding.** Plain (non-IME) chars typed in the echo window
  land whole but in the *old* row — a different, milder corruption class that
  needs its own live repro before building (probe it during verification; file
  a follow-up issue if confirmed).
- Textarea surfaces (description / code block / field name) as composition
  *owners*. They are protected as focus *targets* by the gate; tracking their
  own compositions is a follow-up if it ever surfaces.
- User-initiated focus moves (click, Cmd+K): the IME commits naturally there;
  not the async-echo class.

## Design

Key insight: composition text is **already locally buffered** — composition
transactions skip `onChange`/`onPatch` (`RichTextEditor.tsx` dispatchTransaction)
and only flush at compositionend. So nothing needs to be intercepted, undone, or
replayed against core; the fix only decides *where that buffered text flushes to*.

Four renderer-local pieces, no core/protocol changes:

1. **Global composition gate** (`src/renderer/ui/editor/compositionRelay.ts`).
   Module-level set of live compositions, fed by each RichTextEditor
   (IME keydown / compositionstart begin it; compositionend microtask / blur /
   unmount end it). Solves the cross-editor problem: the per-editor
   `composingRef` is invisible to the *target* editor whose focusRequest effect
   would steal focus.

2. **Park focusRequest application while any composition is live.** The
   focusRequest effect (and the sibling textarea-based consumers:
   OutlinerFieldRow, CodeBlockRow, NodeDescription, BlockNodeRow) returns early
   without consuming when `isCompositionLive()`. The request stays in ui state.

3. **Compositionend handoff** (in the composing editor's compositionend
   microtask, where the final composition transaction has settled):
   - Only requests that **arrived during this composition** are relayed (a
     snapshot of `focusRequest` taken at composition start guards against
     teleporting text to a stale unconsumed request).
   - Request targets *this* editor → flush normally, then apply the parked
     placement.
   - Request targets *another* editor → diff the doc against
     `lastExternalContentRef` (prefix/suffix diff → the composed insertion,
     sentinels stripped), revert the local doc to the echoed external content
     (core's truth — the composed text was never flushed), and relay the text
     via a new `onCompositionHandoff(text)` prop. The host maps it to
     `relayCompositionHandoffState(ui, text)` (new focusModel helper):
     non-empty text → `requestPendingInputState(target, text, placement)`,
     empty (cancelled composition) → fresh `requestFocusState`. The existing
     pendingInput machinery does the rest: focus the new editor, place the
     cursor, insert the text, patch core. (`pendingInputChar.char` already
     handles multi-char strings; the focusRequest effect is declared before the
     pendingInput effect, so placement applies before insertion.)
   - A `pendingHandoff` flag keeps dispatchTransaction buffering between the
     sync compositionend handler and the microtask, so a late final transaction
     can't flush to the old node first.

4. **Empty-block composition anchor**
   (`src/renderer/ui/editor/imeCompositionAnchor.ts`). At composition start
   (IME keydown-229 / compositionstart / first `insertCompositionText`
   beforeinput), `compositionAnchorTransaction(state)` seeds a zero-width
   sentinel into an empty textblock (and the pre-existing inline-ref-adjacent
   cases, refactored into the same pure helper) and parks the caret after it.
   The block then always has a #text node for the IME's marked range, PM
   patches characterData in place across re-segmentations, and the session
   survives. The codec already strips the sentinel from `RichText` and
   patches, so nothing leaks to core.

### Verification notes

- The **echo-race leg** is covered by the CDP probe (`scripts/probe-ime-split.ts`):
  fixed branch 3/3 PASS; `origin/main` baseline reproduces the exact tearing
  signature (partial compositionend + mid-composition focusout).
- The **empty-row leg** can NOT be verified over CDP:
  `Input.imeSetComposition` replaces the whole text node *including* the
  anchor on every update — real macOS IME only rewrites its marked range.
  Verified instead on the live app with a real Pinyin IME + the dev-only
  `[ime-trace]` forensic rail (`compo-tr` logs doc/DOM/compositionNode/
  blockSwapped per composing transaction): two clean runs, anchor present,
  characterData-only updates, `blockSwapped:false` throughout, single
  compositionend carrying the full word. The trace rail stays in the code
  (dev-gated) for future regressions.

### Files

- `src/renderer/ui/editor/compositionRelay.ts` (new) — gate +
  `extractComposedInsertion` + dev-only `imeTrace`.
- `src/renderer/ui/editor/imeCompositionAnchor.ts` (new) —
  `compositionAnchorTransaction` (empty-block + inline-ref anchors, pure).
- `src/renderer/ui/editor/RichTextEditor.tsx` — gate feeding, park, handoff,
  `onCompositionHandoff` prop, anchor dispatch.
- `src/renderer/ui/focus/focusModel.ts` — `relayCompositionHandoffState`.
- `src/renderer/ui/outliner/OutlinerItem.tsx`, `src/renderer/ui/NodePanel.tsx`
  — wire the prop.
- `src/renderer/ui/outliner/{OutlinerFieldRow,CodeBlockRow,NodeDescription,BlockNodeRow}.tsx`
  — gate check in their focusRequest effects.
- `scripts/probe-ime-split.ts` (new) — repeatable CDP acceptance probe
  (`Input.imeSetComposition`; synthetic keystrokes bypass the macOS IME and e2e
  mocks lack the real async echo, so acceptance runs against the live app).
- Tests: `tests/renderer/compositionRelay.test.ts` (new),
  `tests/renderer/imeCompositionAnchor.test.ts` (new),
  `tests/renderer/focusModel.test.ts` (extend).
- Spec: `docs/spec/ui-behavior.md` (IME composition vs async echoes).

## Risks

- **Echo projection apply must not detach the composing editor's DOM** —
  verified as part of the CDP acceptance run (virtualization path); the gate is
  useless if the DOM node itself is remounted.
- Cancelled / selection-replacing compositions: diff helper returns the
  composed insertion independent of net length; revert restores core's truth.
- Unmount-while-composing: cleanup ends the gate and re-issues a parked request
  (text is lost with the dying row — acknowledged edge).

## Collision check

`gh pr list`: only #175 (cc/skill-acceptance) — agent-skills surface
(src/main/*, core protocol, settings UI). No file overlap. This PR deliberately
avoids `src/core/commands.ts` / `types.ts`.
