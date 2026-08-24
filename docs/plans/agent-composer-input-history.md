# Agent Composer Input History

Shape: **(a) ONE complete feature in one PR.** Per-Thread history derivation,
editor navigation, structured draft restoration, attachment lifecycle handling,
tests, and the current Agent rendering specification land together. The
implementation establishes the history state machine before wiring keyboard
events into the composer.

## Goal

Give every editable Agent composer terminal-style input recall without weakening
its existing multi-line, structured-input, focus, or menu behavior.

The minimum acceptable outcome is that a reader can use plain Up and Down from
the visual boundary of the composer to revisit accepted inputs from the current
Thread, edit and resend a recalled copy, and return to the exact unsent draft
that existed before history navigation began. Text, Node references,
attachments, selection, and attachment ownership must survive that round trip.

## Non-goals

- Do not add global or cross-Thread history. History follows the exact editable
  Thread so recalled intent cannot leak across conversations or Agent children.
- Do not add `Ctrl+R`, prefix search, history expansion, Vi/Emacs modes, or new
  shortcut preferences. Those are separate product decisions after boundary
  navigation is proven.
- Do not record raw composer keystrokes or create a second persisted history.
  Canonical `userMessage` Items remain the authority.
- Do not make `/new`, `/clear`, `/compact`, or feature Turns with no
  `userMessage` Item recallable. A direct Skill invocation remains recallable
  because its exact submitted input is canonical user content.
- Do not turn recall into Edit or rollback. Editing a recalled entry creates a
  new submission; the existing latest-message Edit action keeps its rollback
  semantics.
- Do not change Enter, Shift+Enter, Stop, slash-command, mention, paste, staged
  context, model-selection, or `request_user_input` behavior.
- Do not add visible history chrome, status copy, CSS, or renderer theme work.
- Do not change Agent Core protocol, persistence, codecs, commands, or preload
  APIs.

## Design

### Product contract

History recall is a mode of the existing composer, not a transcript action and
not a separate surface. The composer keeps four logical values:

1. the current editable draft bundle;
2. the ordered canonical history entries for the current Thread;
3. the stable `userMessage` Item selected during navigation; and
4. the scratch bundle captured immediately before navigation began.

A draft bundle contains the ProseMirror document and selection, the ordered
structured draft content, the active `ThreadAttachmentContent` values, and the
renderer-only attachment UI ownership needed to restore unsent previews and
source identity. Recalled canonical history is copied into a draft bundle; it
is never edited in place.

### Canonical history source

Derive entries lazily from the `Turn[]` already supplied to `ThreadView`. The
Thread store loads every Turn page with `itemsView: 'full'`, so history recall
does not need a second query, cache, or persistence format.

Each canonical `userMessage` Item is one entry, including steering Items inside
an active Turn. Preserve Item order across Turns and within each Turn; do not
flatten all user content in a Turn into one entry. Use the Item ID as stable
navigation identity and its accepted structured `content` as the source.

The history selector runs only when navigation is requested. Streaming deltas
must not add an O(Thread history) derivation to the render hot path. While a
reader is browsing, reconcile against the newest entry list by selected Item ID:
newer accepted inputs become reachable through Down without moving the selected
entry, and a rolled-back selected Item falls back to the closest surviving
neighbor or the scratch slot.

### Navigation state machine

The idle state has no history cursor. On the first eligible Up:

1. snapshot the current draft bundle as scratch;
2. select the newest canonical history entry;
3. materialize a working copy in the editor; and
4. place the caret at the end of that recalled content.

Further eligible Up events select older entries. Eligible Down events select
newer entries. Down past the newest entry restores the scratch bundle, including
its original selection, and returns to idle. Moving beyond the oldest entry is
a handled no-op so the caret does not unexpectedly leave history navigation.

Before leaving any slot, retain its current working bundle for the lifetime of
that navigation session. Returning to the slot restores edits made during the
same session without changing the canonical Item. This includes attachments or
references added after recall. The session ends when the reader returns to
scratch, submits, clears the editor through an established product path, or the
owning ThreadView unmounts.

A submit exits history mode before admission. A refused send restores the
submitted snapshot through the existing failure path as an ordinary idle draft;
it does not create a history entry. Once the resulting canonical
`userMessage` arrives, the next Up can recall it normally.

### Keyboard ownership and visual boundaries

Keep the current event priority:

1. disabled composer and IME composition guards;
2. open slash or mention trigger, which owns Up, Down, Enter, Tab, and Escape;
3. Stop and submission shortcuts;
4. history navigation; and
5. ProseMirror/browser editing defaults.

History handles only unmodified `ArrowUp` and `ArrowDown` with a collapsed text
selection. Shift selection and Meta, Control, or Alt movement remain native.
Node selections do not enter history.

Use `EditorView.endOfTextblock('up' | 'down')` to decide whether vertical motion
would leave the current text block. This is the ProseMirror layout-aware
authority for explicit hard breaks, soft-wrapped visual lines, and bidirectional
text. Up enters or advances history only at the first visual line; Down advances
or exits only at the last visual line. A single visual line is both boundaries.

The editor reports an eligible navigation request to `ThreadView`; it does not
import Thread protocol history or own attachment lifecycle. If no entry exists,
the callback declines the request and native cursor behavior remains unchanged.

### Structured draft materialization

Preserve the exact ordered `ThreadUserContent[]` shape:

- text parts become text plus hard-break nodes without merging across reference
  atoms;
- Node references retain their `nodeId`, use the current document label when
  resolvable, and fall back to the canonical note;
- attachments retain canonical source and artifact metadata but receive fresh
  composer attachment IDs, so a recalled copy never aliases the original
  message-part identity; and
- recalled attachment atoms use the established generic icon/name presentation
  when renderer-only thumbnail data is unavailable.

Submitting recalled content follows the ordinary `threadContentFromDraft`
route. It reuses Thread-owned payload bytes or the canonical local-file source;
it never copies bytes merely to browse history. Existing main-process admission
remains the availability authority. If a local file or managed payload is no
longer readable, send fails through the existing recoverable composer error and
draft restoration path rather than crashing navigation or silently dropping the
part.

### Attachment ownership across hidden draft slots

The existing composer cleanup correctly discards an unsent managed attachment
when its visible atom is removed. History swaps introduce temporarily hidden
draft slots, so a navigation session must retain the union of attachments owned
by scratch and saved working bundles.

During an internal history swap, update attachment refs and the visible editor
as one composer operation and suppress ordinary removed-atom reclamation for
attachments still owned by another session slot. Preserve renderer-only object
URLs and source keys while their slot remains recoverable.

When the session ends, release every inactive slot. Revoke its renderer-only UI
state and request discard for managed payloads no longer referenced by the
visible draft. The main-process resource store remains authoritative: payloads
also owned by canonical Thread history survive the discard request. Unmount and
Thread switching use the same final cleanup, so browsing cannot leak draft-only
resources.

### Component boundaries

Add `src/renderer/agent/threadComposerHistory.ts` for the pure history entry
selector and ID-anchored navigation reducer. It must not own React, DOM,
ProseMirror, persistence, or resource cleanup.

Update `ThreadComposerEditor` to:

- include selection in `ThreadComposerEditorSnapshot` and restore it safely;
- materialize ordered structured composer content with an explicit final-caret
  option for a fresh history entry;
- use `endOfTextblock` for eligible plain-arrow requests; and
- expose a narrow history-navigation callback while preserving trigger-menu
  ownership.

Update `ThreadView` to own canonical entry lookup, history session refs, draft
bundle swaps, fresh attachment identities, and retained-resource cleanup. Keep
history-session changes out of React render state unless visible draft state
already requires a render.

Update `docs/spec/agent-thread-rendering.md` in the same implementation change.
The owning specification must define the canonical source, per-Thread boundary,
visual-line keyboard precedence, scratch restoration, structured recall,
control-command exclusion, and attachment degradation behavior.

### Product rules

- **BR-1:** History contains only canonical `userMessage` Items belonging to the
  exact composer Thread.
- **BR-2:** One `userMessage` Item is one history entry, even when multiple user
  messages belong to one Turn.
- **BR-3:** Recall produces a mutable draft copy and never mutates, rolls back,
  or re-identifies the canonical entry.
- **BR-4:** History navigation never changes staged page context, provider/model
  selection, reasoning effort, transcript position, or active Turn state.
- **BR-5:** No internal navigation step may reclaim an attachment still owned by
  a recoverable scratch or working slot.

### Acceptance criteria

- **AC-1:** When a collapsed caret on the first visual line receives plain Up
  with no trigger menu open, the composer recalls the newest current-Thread
  entry; repeated eligible Up recalls older entries.
- **AC-2:** When the caret can still move vertically within a multi-line or
  soft-wrapped draft, Up and Down retain native cursor movement and do not
  replace the draft.
- **AC-3:** When Down advances past the newest history entry, the composer
  restores the exact pre-navigation document, selection, references,
  attachments, and attachment UI ownership.
- **AC-4:** While slash or mention suggestions are open, Up and Down navigate
  that list and never navigate input history, including an empty result list.
- **AC-5:** While IME composition is active, the selection is non-collapsed, a
  Node atom is selected, or a modifier is held, arrows preserve the established
  editor behavior.
- **AC-6:** When a recalled entry containing interleaved text, Node references,
  and attachments is submitted, the new canonical input preserves part order,
  semantic references, and resource sources while using fresh attachment IDs.
- **AC-7:** When the reader edits a recalled slot, navigates away, and returns
  during the same session, the working edit returns without altering the source
  history Item.
- **AC-8:** When a send is rejected, its recalled or scratch draft returns once,
  remains idle-editable, and the rejected attempt does not appear as another
  history entry.
- **AC-9:** When Threads are switched or a feature Turn has no user message,
  content from that Thread or control action is not recallable in the current
  composer.
- **AC-10:** When history navigation ends by restore, submit, clear, or unmount,
  every inactive draft-only attachment is released exactly once, while a
  payload retained by canonical history remains available.

### Risks and mitigations

- **Visual boundary false positives:** hand-written coordinate comparisons are
  fragile under soft wrap, zoom, and bidirectional text. Use ProseMirror's
  layout-aware authority and verify through real Chromium E2E.
- **Draft resource loss or leaks:** the existing cleanup assumes one visible
  draft. Model scratch and working-slot ownership explicitly, centralize swaps,
  and test every exit path with managed pathless attachments.
- **History drift during live updates or rollback:** anchor browsing by Item ID,
  never array index, and define deterministic fallback when an entry disappears.
- **Hot-path regression:** derive history only on navigation events and keep the
  session in refs; do not scan all Turns on every stream delta or add per-delta
  React state.
- **Semantic collision with Edit:** tests must prove recall issues an ordinary
  submit without `thread/rollback`, while latest-message Edit retains the
  established rollback contract.

## Open questions

None. The selected target is per-Thread canonical history, visual-boundary
plain-arrow navigation, exact structured restoration, and session-local working
copies. Reverse search and alternate keymaps require a separate product review.

## Implementation checklist

- [ ] Add the pure history selector/reducer and focused renderer tests covering
  entry ordering, bounds, scratch, working copies, dynamic entry reconciliation,
  and reset.
- [ ] Extend the editor snapshot/materialization seam and wire layout-aware,
  priority-preserving arrow handling.
- [ ] Integrate Thread-owned session bundles and attachment retention/cleanup in
  `ThreadView`.
- [ ] Add Agent Thread E2E for single-line recall, multi-line and soft-wrap
  boundaries, menu/IME/modifier priority, structured resend, Thread isolation,
  refused-send restoration, and managed-resource cleanup.
- [ ] Fold the shipped behavior into `docs/spec/agent-thread-rendering.md` and
  verify no visual or focus regression in light and dark mode.
- [ ] Run `bun run typecheck`, `bun run test:renderer`,
  `bun run test:e2e -- tests/e2e/agent-thread.spec.ts`,
  `bun run docs:check`, and `git diff --check`.
