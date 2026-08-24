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
that existed before history navigation began. Text, Node references, inline
attachment positions, the linked attachment tray, selection, and resource
ownership must survive that round trip as one coherent composer state.

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
- Do not make pending attachment admissions recallable or suspend their
  controllers in hidden history slots. History waits for the current picker,
  drop, paste, browser-file, or mention admission to settle, cancel, or fail.

## Design

### Product contract

History recall is a mode of the existing composer, not a transcript action and
not a separate surface. Its product object is one complete submitted composer
state, not text completion. The composer keeps four logical values:

1. the current editable draft bundle;
2. the ordered canonical history entries for the current Thread;
3. the stable `userMessage` Item selected during navigation; and
4. the scratch bundle captured immediately before navigation began.

A draft bundle contains the ProseMirror document and selection, the ordered
structured draft content, the settled `ThreadAttachmentContent` values, and the
renderer-only attachment UI metadata needed to restore unsent preview URLs,
source keys, and pasted-text excerpts. One visible attachment is a linked
projection over one attachment identity: its resource content, its inline
`fileReference` atom, and its derived tray card must be restored or removed
together. Recalled canonical history is copied into a draft bundle; it is never
edited in place. In-flight attachment operations, pending request controllers,
pending atoms, and their replaced slices are not draft-bundle state.

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

1. decline history navigation if any attachment operation is queued or running,
   including a visible pending file reference;
2. snapshot the current settled draft bundle as scratch;
3. select the newest canonical history entry;
4. materialize a working copy in the editor; and
5. place the caret at the end of that recalled content.

Further eligible Up events select older entries. Eligible Down events select
newer entries. Down past the newest entry restores the scratch bundle, including
its original selection, and returns to idle. Moving beyond the oldest entry is
a handled no-op so the caret does not unexpectedly leave history navigation.

Before leaving any slot, retain its current working bundle for the lifetime of
that navigation session. Returning to the slot restores edits made during the
same session without changing the canonical Item. This includes settled
attachments or references added after recall. If any serialized attachment
operation is queued or running in the visible slot, navigation pauses in place:
plain Up and Down keep their native editor behavior and no slot is snapshotted,
hidden, or replaced. This covers operations without an inline pending atom as
well as generated large-paste requests. Navigation becomes eligible again after
the operation settles, cancels, or fails, so a late result cannot commit into a
different history slot. The session ends when the reader returns to scratch,
submits, clears the editor through an established product path, or the owning
ThreadView unmounts.

A submit exits history mode before admission. A refused initial send or steer
restores the submitted bundle through the existing failure path as an ordinary
idle draft; it does not create a history entry. Restore happens once and keeps
the inline marker, tray projection, and resource content coherent. Once the
resulting canonical `userMessage` arrives, the next Up can recall it normally.

An active Turn does not change recall semantics. The attachment picker and
other new-file admissions remain unavailable as today, but history may recall
settled attachments because it reuses an already canonical resource rather than
starting a new upload. The recalled bundle is submitted through ordinary steer
admission, including the existing main-process attachment validation. History
never strips attachments, skips attachment-bearing entries, or presents a
text-only approximation. If the source is no longer admissible, the steer fails
recoverably and restores the complete bundle.

### Keyboard ownership and visual boundaries

Keep the current event priority:

1. disabled composer and IME composition guards;
2. open slash or mention trigger, which owns Up, Down, Enter, Tab, and Escape;
3. Stop and submission shortcuts;
4. history navigation; and
5. ProseMirror/browser editing defaults.

History handles only unmodified `ArrowUp` and `ArrowDown` with a collapsed text
selection in the editor. Shift selection and Meta, Control, or Alt movement
remain native. Node selections do not enter history. When focus is in the
attachment tray, its established Left/Right/Escape behavior remains the sole
keyboard owner and editor history is not invoked.

Use `EditorView.endOfTextblock('up' | 'down')` to decide whether vertical motion
would leave the current text block. This is the ProseMirror layout-aware
authority for explicit hard breaks, soft-wrapped visual lines, and bidirectional
text. Up enters or advances history only at the first visual line; Down advances
or exits only at the last visual line. A single visual line is both boundaries.

The editor reports an eligible navigation request to `ThreadView`; it does not
import Thread protocol history or own attachment lifecycle. If no entry exists
or `ThreadView` reports an in-flight attachment operation, the callback declines
the request and native cursor behavior remains unchanged.

### Structured draft materialization

Preserve the exact ordered `ThreadUserContent[]` shape:

- text parts become text plus hard-break nodes without merging across reference
  atoms;
- Node references retain their `nodeId`, use the current document label when
  resolvable, and fall back to the canonical note;
- attachments retain canonical source and artifact metadata but receive fresh
  composer attachment IDs, so a recalled copy never aliases the original
  message-part identity; and
- recalled attachment atoms and tray cards use the established generic
  name/type/size presentation when renderer-only thumbnail or pasted-text
  excerpt data is unavailable.

Canonical history does not persist renderer-only pasted-text excerpts. A
recalled `Pasted*.txt` therefore degrades to the ordinary text/file tray card
unless the current navigation session already owns an excerpt for that working
copy. It must not synthesize an excerpt from unavailable source bytes. The
mounted draft's pasted-file ordinal remains monotonic across history swaps and
continues to reset only on the established successful-Send boundary, so
navigation cannot create duplicate generated names by rewinding UI state.

Submitting recalled content follows the ordinary `threadContentFromDraft`
route. It reuses Thread-owned payload bytes or the canonical local-file source;
it never copies bytes merely to browse history. Existing main-process admission
remains the availability authority. If a local file or managed payload is no
longer readable, send fails through the existing recoverable composer error and
draft restoration path rather than crashing navigation or silently dropping the
part.

### Attachment ownership and atomic visible-bundle swaps

The existing composer cleanup correctly discards an unsent managed attachment
when its visible atom is removed, and the attachment limits count the current
`attachmentsRef` together with pending requests. History must preserve those
meanings: `attachmentsRef` contains only the currently visible slot. Hidden
scratch and working slots live in a separate history ownership registry and do
not consume the visible 20-attachment or 10-image budgets.

Replace the visible bundle through one centralized composer transaction. The
transaction suppresses ordinary removed-atom reclamation, clears any transient
tray removal preview, projects the target slot's settled attachments and UI
metadata as the active attachment state, restores the editor document and
selection, synchronizes `draftRef`, and only then releases resources from the
departing visible slot that have no remaining owner. React must not commit an
intermediate state containing an inline marker without its tray attachment or a
tray attachment without its marker.

Cleanup and discard decisions query all applicable owners: the visible slot,
hidden history slots, a pending replacement restoration, and canonical Thread
history. Queued operations and pending request controllers remain
visible-slot-only and are never moved into the history registry. While a slot
remains recoverable, preserve its renderer-only object URLs, source keys, and
pasted-text excerpts. The tray's removal preview is interaction state rather
than draft state and is cleared on every history swap instead of being restored.

When the session ends, release every inactive slot. Revoke its renderer-only UI
state and request discard for managed payloads no longer referenced by any
owner. The main-process resource store remains authoritative: payloads also
owned by canonical Thread history survive the discard request. Unmount and
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
bundle swaps, the hidden-slot ownership registry, fresh attachment identities,
an activity count around the serialized attachment-operation queue,
pending-navigation guards, and retained-resource cleanup. Keep history-session
changes out of React render state unless visible draft state already requires a
render. The activity count blocks navigation from enqueue until settlement,
cancellation, or failure, including admissions that never create a pending atom.
The attachment tray remains a pure projection of the active draft, attachments,
pending requests, preview URLs, and excerpts; it does not acquire a second
history state.

Update `docs/spec/agent-thread-rendering.md` in the same implementation change.
The owning specification must define the canonical source, per-Thread boundary,
visual-line keyboard precedence, scratch restoration, structured recall,
control-command exclusion, in-flight-admission pause, active-Turn attachment
reuse, linked marker/tray restoration, visible-only attachment budgets, and
attachment degradation behavior.

### Files and collision result

The implementation is expected to add
`src/renderer/agent/threadComposerHistory.ts` and its renderer test, and update
`ThreadComposerEditor`, `ThreadView`, `tests/e2e/agent-thread.spec.ts`, and
`docs/spec/agent-thread-rendering.md`. No Core protocol, preload, dependency,
build, CSS, or tray-component change is intended.

PR #586 has merged. This plan is reconciled with its pending paste atom, unified
attachment tray, expanded budgets, renderer-only excerpt metadata, and linked
removal behavior; it is no longer an open collision. The only other open claim
is #584. Its future implementation overlap is limited to
`docs/spec/agent-thread-rendering.md`; source and test ownership are otherwise
disjoint. Begin implementation from updated `origin/main` after #584 lands, or
coordinate that specification file before opening the implementation claim.
This plan-only PR edits no main-owned board or changelog file.

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
- **BR-6:** A composer with any queued or running attachment admission does not
  enter, advance, or exit history until the operation settles, cancels, or
  fails, whether or not that operation has a visible pending atom.
- **BR-7:** Hidden history slots retain resources through a separate ownership
  registry but never contribute to current composer attachment budgets.
- **BR-8:** During an active Turn, history may recall and steer settled
  attachments while every ordinary path for adding a new attachment remains
  disabled.
- **BR-9:** Recall is atomic: an attachment resource, inline marker, and tray
  projection are one visible unit and are never partially restored or silently
  omitted.

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
- **AC-11:** While a picker, drop, paste, browser-file, or mention attachment
  operation is queued or running, plain Up and Down do not enter, advance, or
  exit history, do not cancel the operation, and retain native editor movement;
  navigation becomes available after settlement, cancellation, or failure, and
  a successful result commits to the same visible slot that started it.
- **AC-12:** When a history slot containing settled attachments becomes visible,
  each attachment appears at its authored inline position and exactly once in
  the tray before the user can interact with the restored draft.
- **AC-13:** While hidden scratch and working slots retain attachments, picker,
  paste, drop, and mention capacity checks count only the visible slot plus
  pending requests against the 20-attachment and 10-image limits.
- **AC-14:** When a recalled tray card removes an attachment, its paired inline
  marker disappears only from the current working copy; the canonical history
  Item and other session slots remain unchanged.
- **AC-15:** When canonical history recalls a `Pasted*.txt` attachment without a
  renderer excerpt, the tray shows the established generic text/file card and
  never an empty, stale, or fabricated pasted-text preview.
- **AC-16:** While a Turn is active, recalling and submitting a settled
  attachment-bearing entry sends the complete structured content through steer
  admission while new attachment controls remain unavailable; an admission
  failure restores the complete bundle exactly once.
- **AC-17:** When a history swap begins with a tray removal preview active, the
  preview clears and neither the source nor target editor selection changes
  because of that transient UI state.

### Risks and mitigations

- **Visual boundary false positives:** hand-written coordinate comparisons are
  fragile under soft wrap, zoom, and bidirectional text. Use ProseMirror's
  layout-aware authority and verify through real Chromium E2E.
- **Draft resource loss or leaks:** the existing cleanup assumes one visible
  draft. Keep visible state separate from hidden ownership, centralize atomic
  swaps, and test every exit path with managed pathless attachments.
- **Pending admission cancellation or misrouting:** removing a pending marker
  currently cancels its request, while picker, drop, browser-file, and mention
  operations can complete without such a marker. Track the whole serialized
  queue, decline navigation before any editor replacement, and never store
  in-flight controllers in hidden slots.
- **Active-Turn capability mismatch:** the picker is disabled while steering,
  but canonical attachment reuse is valid. Keep new admissions disabled, route
  recalled settled resources through ordinary steer admission, and never
  degrade a structured entry to text.
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
plain-arrow navigation, atomic structured restoration, session-local working
copies, in-flight attachment navigation pause, and settled attachment reuse
during an active Turn. Reverse search and alternate keymaps require a separate
product review.

## Implementation checklist

- [ ] Add the pure history selector/reducer and focused renderer tests covering
  entry ordering, bounds, scratch, working copies, dynamic entry reconciliation,
  and reset.
- [ ] Extend the editor snapshot/materialization seam and wire layout-aware,
  priority-preserving arrow handling.
- [ ] Integrate Thread-owned session bundles and attachment retention/cleanup in
  `ThreadView`, including visible-only budgets, the in-flight admission guard,
  and atomic marker/resource/tray swaps.
- [ ] Add Agent Thread E2E for single-line recall, multi-line and soft-wrap
  boundaries, menu/IME/modifier priority, structured resend, Thread isolation,
  queued admission safety, pending paste safety, tray projection, hidden-slot
  budgets, active-Turn attachment steer, refused-send restoration, and
  managed-resource cleanup.
- [ ] Fold the shipped behavior into `docs/spec/agent-thread-rendering.md` and
  verify no visual or focus regression in light and dark mode.
- [ ] Run `bun run typecheck`, `bun run test:renderer`,
  `bun run test:e2e -- tests/e2e/agent-thread.spec.ts`,
  `bun run docs:check`, and `git diff --check`.
