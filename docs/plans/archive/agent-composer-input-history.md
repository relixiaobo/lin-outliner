# Agent Composer Input History

Shape: **(a) ONE complete feature in one PR.** The canonical input-author
contract, strict persisted-schema cutover, every admission/replay and
transcript consumer, per-Thread history derivation, semantic editor-action
routing, structured draft restoration, attachment lifecycle handling, tests,
and the current Agent specifications land together. Inside that PR, the author
model and codec enforcement land first in build order, followed by storage,
transcript, and history consumers; there is no independently shipped
interface-only slice.

## Goal

Give every editable Agent composer terminal-style input recall without weakening
its existing multi-line, structured-input, focus, speaker attribution, or menu
behavior.

The minimum acceptable outcome is that a reader can use plain Up and Down from
the visual boundary of the composer to revisit accepted inputs from the current
Thread, edit and resend a recalled copy, and return to the exact unsent draft
that existed before history navigation began. Text, Node references, inline
attachment positions, the linked attachment tray, selection, and resource
references must survive that round trip as one coherent composer state. Agent-,
host-, and feature-authored provider inputs must never enter this reader history
or appear as the reader's editable words in the transcript. Inputs persisted
under the superseded authorless schema are intentionally discarded at the
pre-release clean cut rather than guessed, migrated, or carried by a legacy
reader.

## Non-goals

- Do not add global or cross-Thread history. History follows the exact editable
  Thread so recalled intent cannot leak across conversations or Agent children.
- Do not add `Ctrl+R`, prefix search, history expansion, Vi/Emacs modes, or new
  shortcut preferences. Those are separate product decisions after boundary
  navigation is proven.
- Do not record raw composer keystrokes or create a second persisted history.
  Canonical reader-authored `userMessage` Items remain the authority.
- Do not make `/new`, `/clear`, `/compact`, or feature Turns with no
  `userMessage` Item recallable. A direct Skill invocation remains recallable
  because its exact submitted input is canonical user content.
- Do not turn recall into Edit or rollback. Editing a recalled entry creates a
  new submission; the existing latest-message Edit action keeps its rollback
  semantics.
- Do not change Enter, Shift+Enter, Stop, slash-command, mention, paste, staged
  context, model-selection, or `request_user_input` behavior.
- Do not add visible history chrome, status copy, CSS, or renderer theme work.
- Do not expose canonical author as renderer input, infer it from prose,
  Turn position, trigger, or `clientId`, or change provider-role serialization.
  The renderer cannot declare its own trust classification.
- Do not make pending attachment admissions recallable or suspend their
  controllers in hidden history slots. History waits for the current picker,
  drop, paste, browser-file, or mention admission to settle, cancel, or fail.
- Do not create a new binary-resource store, extend per-Thread physical resource
  copying, or copy bytes merely to browse or recall history. Attachment history
  reuses opaque resource references, not physical files.

## Design

### Decision and constraints

- **DEC-1:** The clean-slate answer is to require a known semantic author on
  every newly admitted provider-role user Item, use that fact for both
  transcript trust and reader history, and route editor keys through performable
  semantic actions.
- **DEC-2:** The selected target is the clean-slate model. The PM ratified on
  2026-08-26 that the installed Tenon and clone-scoped test stores may be
  manually reset after all Tenon processes stop. No authorless persisted Item,
  `unknown` author variant, compatibility decoder, rewrite, or automatic startup
  deletion ships.
- **CON-1:** `userMessage` remains the provider-role boundary. Changing how an
  Item projects to a provider request is outside this feature.
- **CON-2:** Main is the trusted admission authority. Renderer requests must not
  be able to self-declare reader identity, and privileged callers must not be
  able to mint it through a generic input DTO.
- **CON-3:** #586's pending-paste atom, unified attachment tray, serialized
  admission queue, linked marker removal, and resource budgets are the current
  composer model and must remain coherent during recall.
- **CON-4:** The approved delivery shape is one complete implementation PR.
  Foundation-before-consumers is an internal build order, not a separately
  shipped protocol slice.
- **CON-5:** Cutover validation starts only after the explicit manual reset of
  `~/Library/Application Support/Tenon/` and clone-scoped
  `~/.lin-outliner-*` userData. The application does not detect, migrate, decode,
  or automatically delete the authorless pre-cutover format.
- **CON-6:** `agent-result-and-file-lifecycle` is the governing target for
  durable Agent content: canonical consumers link domain resource-reference
  records, while one neutral ContentStore retains exact revisions through
  mechanical anchors. This feature must not entrench the existing per-Thread
  binary layout and must keep attachment history behind a replaceable opaque
  resource-reference boundary.
- **CON-7:** #584 shipped the neutral `src/content/` exact-revision
  foundation and Outline AssetRecords that reference it through retention
  anchors, but deliberately does not cut Agent resources over. This feature
  rebases on that foundation, continues to treat the current managed-resource
  reference as an opaque handle, and does not interpret its digest-shaped
  implementation ID.
- **CON-8:** The reference URI foundation shipped in #590 before #584 and this feature.
  Composer history preserves structured Node/file atoms and emits only canonical
  `[[node://...]]` / `[[file:///...]]` projections; it must not retain or restore
  the retired `kind:label^value` text grammar.

A binary `reader | runtime` field is rejected as the minimum patch. It filters
history, but it permanently collapses delegating Agents, peer Agents, host
envelopes, and feature automation into one anonymous speaker and leaves the
transcript dependent on Turn-position heuristics. Inferring from
`TurnTrigger`, `ItemProvenance`, the first Item, or `clientId` is also rejected:
those values describe causation, copy lineage, ordering, and deduplication, and
machine steering can coexist with reader steering inside one active Turn.

### Design basis

- `UserMessageThreadItem` currently records provider-role content but no
  semantic author, while `TurnLifecycle.userMessage` is the common canonical
  constructor. This makes a required Item-level field enforceable at one write
  boundary.
- Existing rollout JSONL events and SQLite projection `item_json` rows contain
  the superseded authorless `userMessage` shape. They are reset before cutover
  verification and are migration inventory only, not an input format the new
  product accepts.
- `ThreadView` currently uses `hostAuthoredEvent` and `hostNoticeItemId` to infer
  that the first user-role Item in a subagent-triggered Turn is non-reader. The
  inference cannot classify a later machine steer and already drives speaker,
  bubble, and Edit trust.
- #586 establishes one serialized attachment-admission queue, a pending paste
  atom, and one linked inline-marker/tray projection. History must switch whole
  settled draft bundles without moving pending controllers between slots.
- Ghostty's `Surface.keyCallback`, `Surface.maybeHandleBinding`,
  `Binding.Flags.performable`, and GTK `Surface.keyEvent` establish the relevant
  input precedent: normalize first, respect active context and IME ownership,
  perform semantic actions before lower-level input, and fall through when a
  performable action declines. Ghostty delegates command history to the shell,
  so only this routing discipline transfers to the composer.

### Product contract

History recall is a mode of the existing composer, not a transcript action and
not a separate surface. Its product object is one complete submitted composer
state, not text completion. The composer keeps four logical values:

1. the current editable draft bundle;
2. the ordered canonical history entries for the current Thread;
3. the navigation cursor, which identifies either a stable `userMessage` Item
   or the scratch position after the newest entry; and
4. the editable scratch working bundle first captured immediately before
   navigation began.

A draft bundle contains the ProseMirror document and selection, the ordered
structured draft content, the settled `ThreadAttachmentContent` values, and the
renderer-only attachment UI metadata needed to restore unsent preview URLs,
source keys, and pasted-text excerpts. One visible attachment is a linked
projection over one attachment identity: its resource content, its inline
`fileReference` atom, and its derived tray card must be restored or removed
together. Recalled canonical history is copied into a draft bundle; it is never
edited in place. In-flight attachment operations, pending request controllers,
pending atoms, and their replaced slices are not draft-bundle state.

The existing `userMessage` name denotes provider role, not who supplied the
words. Add this required Item-level author model to
`UserMessageThreadItem.author`:

```ts
export type ThreadInputAuthor =
  | { readonly kind: 'reader' }
  | { readonly kind: 'agent'; readonly threadId: ThreadId }
  | { readonly kind: 'host' }
  | {
      readonly kind: 'feature';
      readonly feature: string;
      readonly ref?: string;
    };

export type PrivilegedThreadInputAuthor = Exclude<
  ThreadInputAuthor,
  { readonly kind: 'reader' }
>;
```

`reader` means input accepted from the renderer composer. `agent` names the
Thread whose Agent semantically supplied a delegated brief, direct message, or
delivered result. `host` means synthesized runtime framing with no single Agent
speaker. `feature` names an automation, Goal continuation, Memory pass, or other
product feature that generated the input. The optional feature reference is a
stable source reference when one already exists; it is not a display identity.

Four canonical facts remain orthogonal:

| Fact | Answers | Must not be used as |
|---|---|---|
| `userMessage` Item type | Which provider role receives this content? | Proof that the reader wrote it |
| `ThreadInputAuthor` | Who is accountable for the input's words? | Turn causation or copy lineage |
| `ItemProvenance` | Where did this physical Item originate? | Speaker identity |
| `TurnTrigger` | Why did this Turn start? | Author of every Item later admitted to the Turn |

Add the shared `isReaderAuthoredUserMessage` classifier over the canonical Item.
History eligibility, reader-bubble projection, and Edit eligibility use that
classifier rather than maintaining separate notions of reader trust.

Main assigns author at trusted entry points after renderer request decoding.
Renderer start/steer DTOs do not contain `author`; their dedicated lifecycle
paths mint `{ kind: 'reader' }`. Split privileged steering from renderer
steering, and require every privileged start/steer caller to provide a
non-reader author explicitly. The common admission primitive requires an author
with no default, so a future machine caller cannot silently inherit reader
authority. Privileged admission accepts only `PrivilegedThreadInputAuthor`.
The canonical Item codec and every rollout/projection read exhaustively decode
the same union and reject a missing or unrecognized author; there is no
persisted compatibility mode.

Trusted attribution is exact:

| Admission | Canonical author |
|---|---|
| Renderer initial submit or steer | `reader` |
| Delegated child brief | `agent(parentThreadId)` |
| Agent-to-Agent or Agent-to-main message | `agent(senderThreadId)` |
| Child terminal result delivered to its parent | `agent(childThreadId)` |
| Budget notice, explicit delivery sidecar, or exhausted-settlement envelope with no single speaker | `host` |
| Automation prompt | `{ kind: 'feature', feature: 'automation', ref: executionId }` |
| Goal continuation | `{ kind: 'feature', feature: GOAL_CONTINUATION_FEATURE, ref: continuationRef }` |
| Internal Memory or another feature-owned prompt | `{ kind: 'feature', feature, optional ref }` |
| Retry | Preserve each source Item's author |
| Fork | Preserve each copied Item's author |
| New renderer submit after Edit or rollback | A new `reader` Item |

A direct Skill invocation remains reader-authored because the renderer supplied
the canonical input; Skill resolution and context evidence do not change its
author. A `request_user_input` response remains a separate control-plane record,
not a `userMessage`, so this author model does not invent an Item for it.

### Canonical history source

Derive entries lazily from the `Turn[]` already supplied to `ThreadView`. The
Thread store loads every Turn page with `itemsView: 'full'`, so history recall
does not need a second query, cache, or persistence format.

Each Item accepted by `isReaderAuthoredUserMessage` is one entry, including
reader steering Items inside an active Turn. A delegated Agent's initial brief,
a host-mediated child delivery Item, a peer-Agent message, and machine-authored
steering are excluded even though each is a canonical `userMessage`. Preserve
Item order across Turns and within each Turn; do not flatten all reader content
in a Turn into one entry. Use the Item ID as stable navigation identity and its
accepted structured `content` as the source.

Author is durable canonical data. Retry input batches copy it from each source
Item, fork copies retain it through `copyItem`, rollback never reclassifies
surviving Items, and replayed Items use the copied value rather than the actor
who requested retry. A new renderer submission after Edit/rollback is
reader-authored because it is a new composer admission.

### Strict persisted-schema cutover

Use one strict codec graph for admission, rollout JSONL, projection `item_json`,
rebuild, restoration, retry, and fork. A missing or invalid `author` is malformed
new-format data and retains the established Thread quarantine behavior. No code
recognizes the previous key set, infers an author, rewrites append-only history,
or carries a second persisted representation.

Before cutover validation, stop every Tenon process and manually remove
`~/Library/Application Support/Tenon/` plus the clone-scoped
`~/.lin-outliner-*` test stores. The next packaged and development launches
create only the required-author format. This reset is an execution prerequisite,
not product runtime behavior; the application neither detects nor deletes the
old store automatically.

The history selector runs only when navigation is requested. Streaming deltas
must not add an O(Thread history) derivation to the render hot path. While a
reader is browsing, reconcile against the newest entry list by selected Item ID:
newer accepted inputs become reachable through Down without moving the selected
entry. Reconciliation never replaces the visible working draft merely because a
stream update removed its source Item; it runs on the next eligible history
navigation request.

If the selected Item no longer exists, retain its prior zero-based chronological
index `i` and consume that navigation request by re-anchoring exactly once:

1. select the entry now at `i` when it exists;
2. otherwise select the newest surviving entry, which is the predecessor at the
   truncated tail; or
3. when no entry survives, restore scratch and return to idle.

The re-anchor consumes the arrow without applying another Up/Down step. The
departed orphan working bundle is released after the replacement bundle becomes
visible. A subsequent eligible arrow resumes ordinary navigation from the new
anchor. This successor-first, then predecessor, then scratch rule also defines
the middle, tail, deleted-range, and empty-history boundaries without asking the
reducer to guess.

### Transcript author projection

Canonical author also replaces the renderer's existing inference that the first
`userMessage` in a subagent-triggered Turn is host-authored and every later one
is reader-authored. That inference is false for mixed machine and reader
steering, and adding a durable author only for history would preserve the same
trust bug in another consumer.

Project each provider-role user Item independently:

- `reader` uses the established reader-side bubble and is the only author kind
  eligible for Edit;
- `agent(threadId)` uses that Agent Thread's resolved identity and the
  established opposite-side prose presentation;
- `host` and `feature` use the existing neutral Agent-event presentation and
  never borrow the reader or the transcript's own Agent identity; and
- an unavailable Agent identity degrades to the same neutral event speaker
  instead of guessing another participant.

Delete `hostAuthoredEvent`, `hostNoticeItemId`, and the "first user Item" speaker
rule. The existing `SubagentReport` remains the content projection for a child
terminal delivery, but its speaker comes from that Item's canonical
`agent(childThreadId)` author. Copy remains available for visible provider-role
user Items. Edit requires both the existing latest-terminal-message conditions
and `isReaderAuthoredUserMessage`, so a delegated brief, peer message, host
envelope, feature prompt, or machine steer can never become a reader-authored
rollback submission.

Renderability follows the same structured Item boundary for every author. A
`userMessage` with no attachment or Node reference and only empty or
whitespace text produces no bubble, speaker run, copy target, accessibility
output, or spacing. Attachment-only and Node-reference-only reader Items remain
visible. When a resolved `SubagentReport` replaces a delivery Item, the report
is that Item's visible projection; the underlying content does not suppress the
replacement.

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
its current working document and selection, but keeps the navigation session at
the scratch position. A subsequent eligible Up restores the newest entry's
working copy rather than rematerializing its canonical content. Moving beyond
the oldest entry is a handled no-op so the caret does not unexpectedly leave
history navigation.

Before leaving any slot, retain its current working bundle for the lifetime of
that navigation session, including scratch. Returning to the slot restores edits
made during the same session without changing the canonical Item. This includes
settled attachments or references added after recall. If any serialized
attachment operation is queued or running in the visible slot, navigation
pauses in place: plain Up and Down keep their native editor behavior and no slot
is snapshotted, hidden, or replaced. This covers operations without an inline
pending atom as well as generated large-paste requests. Navigation becomes
eligible again after the operation settles, cancels, or fails, so a late result
cannot commit into a different history slot. The session ends when the reader
submits, clears the editor through an established product path, the owning
ThreadView unmounts, or a removed selected Item has no surviving history entry
to navigate back to.

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

### Semantic input routing and visual boundaries

Adopt Ghostty's input-routing principle rather than its shell-history behavior.
Ghostty normalizes a raw key event, gives the active context and binding action
first refusal, and consumes a performable binding only when its action actually
performs; a declined performable action behaves as if no binding existed. The
composer uses the same contract at its own boundaries:

```text
raw editor key
-> earlier owner
   -> menu owns: history is not invoked; the menu decides consumption
   -> IME owns: history is not invoked; the IME/editor path decides
-> offer semantic history action
   -> performed: consume the key
   -> declined: fall through to ProseMirror/browser movement
```

Keep this ownership order:

1. disabled composer and IME composition guards, which never invoke history;
2. open slash or mention trigger, which owns Up, Down, Enter, Tab, and Escape
   before history even when its current result list is empty;
3. Stop and submission shortcuts;
4. performable history actions; and
5. ProseMirror/browser editing defaults.

When no earlier owner claims the raw Up or Down key, normalize it into a
`historyOlder` or `historyNewer` request and pass it through a narrow semantic-
action callback. `ThreadComposerEditor` owns DOM key, focus, IME, selection,
menu, modifier, and visual-layout facts; it does not import Thread history or
attachment lifecycle. The request carries those editor-owned eligibility facts
to the Thread-owned history controller, which combines them with attachment and
history state and returns `performed | declined`. The editor calls
`preventDefault` only for `performed`; a callback result of `declined` makes no
editor mutation and falls through unchanged. A menu or IME path is not a
`declined` history action because the history callback was never called.

History performs only for an editor-focused, unmodified Up or Down request with
a collapsed text selection, the required visual boundary, no queued or running
attachment admission, and an applicable history transition. Requests with Shift
selection, Meta, Control, or Alt modifiers, or Node/non-collapsed selections are
offered after earlier ownership and decline back to native editor behavior. When
focus is in the attachment tray, its established Left/Right/Escape behavior
remains the sole keyboard owner and editor history is not invoked.

Use `EditorView.endOfTextblock('up' | 'down')` as the ProseMirror layout-aware
authority for explicit hard breaks, soft-wrapped visual lines, and bidirectional
text. Up enters or advances history only at the first visual line; Down advances
or exits only at the last visual line. A single visual line is both boundaries.

Down while idle, an Up with no eligible entry, an ineligible boundary, or an
in-flight attachment admission returns `declined`, preserving native cursor
behavior. Once history owns the draft, Up at the oldest entry is a performed
boundary no-op so the caret does not escape the recalled slot; Down past the
newest performs the scratch restoration. A missing-anchor re-anchor is also
performed, including the transition that restores scratch because no entry
survives.

### Structured draft materialization

Preserve the exact ordered `ThreadUserContent[]` shape:

- text parts become text plus hard-break nodes without merging across reference
  atoms;
- Node references retain their `nodeId`, use the current document label when
  resolvable, and fall back to the canonical note;
- attachments retain canonical source and artifact metadata but receive fresh
  composer attachment IDs, so a recalled copy never aliases the original
  message-part identity; and
- a successful send retains any already-admitted image preview as renderer-only
  canonical-session UI state, so a recalled copy aliases that preview lease
  under its fresh attachment ID without reading or copying source bytes. When
  thumbnail or pasted-text excerpt data is unavailable, recalled atoms and tray
  cards use the established generic name/type/size presentation.

The renderer send boundary preserves the complete admission result. Its
`deduplicated` disposition determines whether submitted attachment identities
became canonical; the nullable `turn` field determines only whether main opened
a new Turn for layout and anchoring. A successful steer has `turn: null` and
still transfers every already-known submitted preview lease to its accepted
canonical attachment identity.

Canonical history does not persist renderer-only pasted-text excerpts. A
recalled `Pasted*.txt` therefore degrades to the ordinary text/file tray card
unless the current navigation session already owns an excerpt for that working
copy. It must not synthesize an excerpt from unavailable source bytes. The
mounted draft's pasted-file ordinal remains monotonic across history swaps and
continues to reset only on the established successful-Send boundary, so
navigation cannot create duplicate generated names by rewinding UI state.

Submitting recalled content follows the ordinary `threadContentFromDraft`
route. It reuses the existing canonical resource reference. In the target model,
that is an Agent resource-reference record whose exact-revision representation resolves
through ContentStore; in this PR it is necessarily the current managed-resource
handle behind a narrow opaque adapter because the Agent cutover lands later.
History compares and retains the whole handle as an identity value but never
extracts, logs, persists separately, displays, or constructs its current
digest-shaped `id`. It never copies bytes merely to browse history. Existing
main-process admission remains the availability authority. If a local file or
managed content reference is no longer readable, send fails through the
established recoverable composer error and draft restoration path rather than
crashing navigation or silently dropping the part.

### Attachment reference retention and atomic visible-bundle swaps

The existing composer cleanup correctly discards an unsent managed attachment
when its visible atom is removed, and the attachment limits count the current
`attachmentsRef` together with pending requests. History must preserve those
meanings while treating each resource handle as an opaque reference:
`attachmentsRef` contains only the currently visible slot. Hidden scratch and
working slots live in a separate history reference-retention registry and do
not consume the visible 20-attachment or 10-image budgets.

Replace the visible bundle through one centralized composer transaction. The
transaction suppresses ordinary removed-atom reclamation, clears any transient
tray removal preview, projects the target slot's settled attachments and UI
metadata as the active attachment state, restores the editor document and
selection, synchronizes `draftRef`, and only then requests discard for handles
from the departing visible slot that have no surviving link. React must not
commit an intermediate state containing an inline marker without its tray
attachment or a tray attachment without its marker.

Cleanup and discard decisions query every surviving link: the visible slot,
hidden history slots, a pending replacement restoration, and canonical Thread
history. Queued operations and pending request controllers remain
visible-slot-only and are never moved into the retention registry. While a slot
remains recoverable, preserve its renderer-only object URLs, source keys, and
pasted-text excerpts. The tray's removal preview is interaction state rather
than draft state and is cleared on every history swap instead of being restored.
An accepted canonical attachment retains only its already-known preview lease
for the lifetime of the mounted Thread view. Fresh recalled IDs share that lease;
removing the canonical Item or the last draft alias revokes it, and navigation
never invokes file preview or materialization code.

When the session ends, release every inactive slot. Revoke its renderer-only UI
state and request discard for managed content references with no surviving
canonical or session link. A canonical Thread reference keeps the same content
available regardless of a draft-slot discard request. Unmount and Thread
switching use the same final cleanup, so browsing cannot leak draft-only
resources.

### Component boundaries

Update `src/core/agent/protocol.ts` and `src/core/agent/codec.ts` first within the
single implementation PR to define `ThreadInputAuthor`, the required
`UserMessageThreadItem.author`, privileged admission types, one exhaustive
strict codec graph, the shared `isReaderAuthoredUserMessage` classifier, and
distinct renderer versus privileged steer request contracts. Renderer request
codecs continue to reject an `author` key. A privileged request requires a
non-reader author; retry and fork preserve the exact existing canonical author.

Update `RolloutStore` and `ThreadHistoryProjectionStore` immediately after the
codec foundation. Raw JSONL, SQLite rows, append, live event application, and
projection writes all use strict canonical decoding. Focused persistence tests
must cover every recorded-notification Item carrier, `history/retry`, projection
read and rebuild, projection-to-rollout restoration, and rejection/quarantine of
missing or invalid new-format authors. There is no installed-history
compatibility fixture.

Update `TurnLifecycle` and `ThreadService` so `startRendererTurn` and
`steerRendererTurn` mint `reader`, while `startPrivilegedTurn`,
`tryStartTurnIfIdle`, and `steerPrivilegedTurn` require the caller's explicit
known non-reader author. The common `userMessage` constructor requires the
author and has no default. Update `SubagentCollaboration`, `GoalExtension`,
`AutomationDispatcher`, Memory admission, budget notices, explicit sidecars,
and exhausted settlement to supply the exact attribution table above. Extend
`CanonicalTurnRetryInputBatch` to retain each source Item's author. Verify that
`ThreadCatalogOps.copyItem` preserves it through the normal codec path.

Update the transcript projection in `ThreadView`, `ThreadItemView`, and
`ThreadSpeaker` to consume canonical author per Item. Remove Turn-position
author inference and gate reader bubble/Edit behavior through the shared
classifier before history is added.

Add `src/renderer/agent/threadComposerHistory.ts` for the pure history entry
selector and ID-anchored navigation reducer. It filters exclusively through
`isReaderAuthoredUserMessage` and implements the exact removed-anchor rule. It
must not own React, DOM, ProseMirror, persistence, or resource cleanup.

Update `ThreadComposerEditor` to:

- include selection in `ThreadComposerEditorSnapshot` and restore it safely;
- materialize ordered structured composer content with an explicit final-caret
  option for a fresh history entry;
- use `endOfTextblock` for eligible plain-arrow requests;
- let trigger menus and IME own their raw keys without invoking history;
- offer remaining Up/Down requests with editor-owned eligibility facts to the
  semantic history action; and
- consume only a `performed` result while preserving callback-decline native
  editor fallthrough.

Update `ThreadView` to own canonical entry lookup, history session refs, draft
bundle swaps, the hidden-slot reference-retention registry, fresh attachment
identities,
an activity count around the serialized attachment-operation queue,
pending-navigation guards, and retained-resource cleanup. Keep history-session
changes out of React render state unless visible draft state already requires a
render. The activity count blocks navigation from enqueue until settlement,
cancellation, or failure, including admissions that never create a pending atom.
The attachment tray remains a pure projection of the active draft, attachments,
pending requests, preview URLs, and excerpts; it does not acquire a second
history state.

Update `docs/spec/agent-core.md`, `docs/spec/agent-model-runtime.md`, and
`docs/spec/agent-thread-rendering.md` in the same implementation change. The
owning specifications must define the required strict author and clean storage
cutover; distinguish provider role, canonical author, Item provenance, and Turn
trigger; define trusted assignment, retry/fork
preservation, and transcript projection; and define canonical history source,
per-Thread boundary, semantic key-action fallthrough, visual-line eligibility,
scratch restoration, deterministic removed-anchor reconciliation, structured
recall, control-command exclusion, in-flight-admission pause, active-Turn
attachment reuse, linked marker/tray restoration, visible-only attachment
budgets, and attachment degradation behavior.

### Files and collision result

The implementation is expected to update `src/core/agent/protocol.ts`,
`src/core/agent/codec.ts`, `RolloutStore`, `ThreadHistoryProjectionStore`,
`TurnLifecycle`, `ThreadService`, `SubagentCollaboration`, `GoalExtension`,
`AutomationDispatcher`, `ThreadCatalogOps`, focused Core and persistence tests,
and canonical fixtures; add
`src/renderer/agent/threadComposerHistory.ts` and its renderer test; and update
`ThreadComposerEditor`, `ThreadView`, `ThreadItemView`, `ThreadSpeaker`,
`tests/e2e/agent-thread.spec.ts`, `docs/spec/agent-core.md`,
`docs/spec/agent-model-runtime.md`, and `docs/spec/agent-thread-rendering.md`. No
command, preload API, dependency, build, new CSS, or tray-component change is
intended.

PRs #586 and #584 have merged. This plan is reconciled with the pending paste
atom, unified attachment tray, expanded budgets, renderer-only excerpt
metadata, and linked removal behavior. #584 is no longer an open collision; it
established the neutral exact-revision ContentStore, Outline references, and
substantial Agent surface retirement. Rebase PR #587 on current `origin/main`
and rerun the file-scope check before marking it Ready. After that rebase, keep attachment
history behind the narrow current-resource adapter: #584 does not provide Agent
resource-reference records, and this
feature must neither invent them nor add physical copy behavior. The PM has
selected one complete implementation PR despite the shared author field:
foundation-first is the internal build order, not a separately shipped
interface PR. This plan-only PR edits no main-owned board or changelog file.

### Product rules

- **BR-1:** History contains only canonical reader-authored `userMessage` Items
  belonging to the exact composer Thread.
- **BR-2:** One reader-authored `userMessage` Item is one history entry, even
  when multiple provider-role user messages belong to one Turn.
- **BR-3:** Recall produces a mutable draft copy and never mutates, rolls back,
  or re-identifies the canonical entry.
- **BR-4:** History navigation never changes staged page context, provider/model
  selection, reasoning effort, transcript position, or active Turn state.
- **BR-5:** No internal navigation step may reclaim an attachment still
  referenced by a recoverable scratch or working slot.
- **BR-6:** A composer with any queued or running attachment admission does not
  enter, advance, or exit history until the operation settles, cancels, or
  fails, whether or not that operation has a visible pending atom.
- **BR-7:** Hidden history slots retain resource handles through a separate
  reference-retention registry but never contribute to current composer
  attachment budgets.
- **BR-8:** During an active Turn, history may recall and steer settled
  attachments while every ordinary path for adding a new attachment remains
  disabled.
- **BR-9:** Recall is atomic: an attachment resource, inline marker, and tray
  projection are one visible unit and are never partially restored or silently
  omitted.
- **BR-10:** A known canonical author is assigned only by trusted main admission.
  Every canonical author is preserved by retry, replay, fork, projection rebuild,
  rollout restoration, and surviving rollback history.
- **BR-11:** An Agent-, host-, or feature-authored `userMessage` is never
  recallable or editable as reader input. That outcome does not change with Turn
  trigger, position, `clientId`, text, or coexistence with reader Items.
- **BR-12:** A removed history anchor resolves by its prior chronological index:
  successor at that index, otherwise newest predecessor, otherwise scratch and
  idle.
- **BR-13:** Provider role, canonical author, Item provenance, and Turn trigger
  are independent facts; no consumer reconstructs one from another.
- **BR-14:** A menu or IME owner prevents the history callback from running and
  decides its own key handling. Once an arrow is offered to history, the editor
  consumes it only when the controller returns `performed`; `declined` preserves
  the established ProseMirror/browser behavior.
- **BR-15:** Only reader-authored Items use the reader bubble or expose Edit.
  Agent Items use their source Thread identity; host, feature, and unresolved
  Agent Items use neutral Agent-event presentation.
- **BR-16:** New renderer and privileged admissions require a known author and
  never default one. Every persisted read uses the same strict canonical author
  decoder; a missing or invalid author fails closed.
- **BR-17:** Stored rollout and projection data use the same required-author
  schema. No storage decoder recognizes an older shape, infers an author from
  surrounding data, or rewrites persisted history.
- **BR-18:** Recall and hidden-slot retention track opaque resource references,
  not byte stores. They never copy physical bytes, create a per-Thread resource
  duplicate, derive identity from the current digest-shaped field, or resolve
  content outside the existing main-process authority.

### Acceptance criteria

- **AC-1:** When a collapsed caret on the first visual line receives plain Up
  with no trigger menu open, the composer recalls the newest reader-authored
  current-Thread entry; repeated eligible Up recalls older reader entries.
- **AC-2:** When the caret can still move vertically within a multi-line or
  soft-wrapped draft, Up and Down retain native cursor movement and do not
  replace the draft.
- **AC-3:** When Down advances past the newest history entry, the composer
  restores the latest scratch working document, selection, references,
  attachments, and attachment UI state without ending the navigation session;
  a subsequent Up restores the newest entry's edited working copy.
- **AC-4:** While slash or mention suggestions are open, including with an empty
  result list, the menu receives Up and Down before history, the history callback
  is not invoked, and the menu alone decides whether to consume the key.
- **AC-5:** While IME composition is active, Up and Down do not invoke history;
  the established IME/editor path alone decides the key's effect.
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
- **AC-18:** When a delegated child Thread contains its
  `agent(parentThreadId)` initial brief followed by a reader-authored steer, Up
  recalls the reader steer and never the delegated brief.
- **AC-19:** When a parent Thread receives a host-mediated
  `agent(childThreadId)` terminal delivery or an `agent(senderThreadId)` peer
  message as provider-role user input, neither Item appears in reader history.
- **AC-20:** When host- or feature-authored steering and reader-authored steering
  coexist in one active Turn, history recalls each reader steer in canonical
  order and excludes every machine-authored steer.
- **AC-21:** When reader, Agent, host, and feature Items pass through codec
  round-trip, retry replay, and fork copy, each retains its exact author. A
  missing or invalid author fails strict canonical decode, renderer request
  payloads cannot set author, and privileged requests cannot declare `reader`.
- **AC-22:** When the transcript projects provider-role user Items, only
  reader-authored Items use the reader bubble or expose Edit. Agent-authored
  Items use the named source Thread identity, while host, feature, and
  unavailable Agent identities use neutral Agent-event presentation without
  borrowing the transcript's own Agent identity.
- **AC-23:** When the selected source Item disappears, the visible working draft
  remains unchanged until the next eligible history arrow; that request selects
  the entry now at the old index, otherwise the newest predecessor, and restores
  scratch/idle only when history is empty, without applying a second movement.
- **AC-24:** After an Up or Down key has been offered to the history callback,
  when no applicable entry exists, the visual boundary is not reached, the
  selection is non-collapsed or a Node atom, a modifier is held, or an attachment
  admission is in flight, the callback returns `declined` without
  `preventDefault`, makes no editor mutation, and native editor behavior receives
  the key.
- **AC-25:** While history owns a recalled slot, Up at the oldest entry consumes
  the key as a performed boundary no-op; Down past the newest consumes the key
  after restoring scratch while retaining the session, and a missing-anchor
  reconciliation with no surviving entries consumes the key only after
  restoring scratch and returning to idle.
- **AC-26:** With all Tenon processes stopped, the documented one-time manual
  reset removes the installed and clone-scoped authorless stores. The first
  subsequent packaged and development launches create only required-author
  records, and no runtime migration, legacy read, rewrite, or automatic deletion
  path exists.
- **AC-27:** When rollout or projection data in the new store contains a missing
  or invalid author, every read/rebuild/restoration path applies the same strict
  decoder and triggers the established unreadable-Thread quarantine rather than
  inferring or defaulting an author.
- **AC-28:** When a history session recalls, edits, hides, restores, submits, or
  discards attachment-bearing entries, every surviving canonical or session
  link keeps the unchanged opaque resource reference live. Filesystem inventory
  and storage-operation probes observe no new physical byte copy created solely
  by history navigation, and renderer history code never reads or emits the
  current digest-shaped reference ID separately.

### Risks and mitigations

- **Visual boundary false positives:** hand-written coordinate comparisons are
  fragile under soft wrap, zoom, and bidirectional text. Use ProseMirror's
  layout-aware authority and verify through real Chromium E2E.
- **Draft resource loss or leaks:** the existing cleanup assumes one visible
  draft. Keep visible state separate from hidden reference retention, centralize atomic
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
- **Author laundering:** provider-role `userMessage`, Turn trigger, provenance,
  position, and `clientId` are each insufficient to identify the speaker.
  Require the canonical union, keep `reader` exclusive to renderer admission,
  require explicit non-reader attribution from privileged callers, and test
  mixed author kinds inside one Turn.
- **Half-adopted author model:** adding author only to history would leave the
  transcript and Edit action on unsafe heuristics. Convert speaker grouping,
  bubble placement, and Edit eligibility in the same PR, and delete the old
  first-Item inference rather than keeping two authorities.
- **Stale pre-cutover store reused accidentally:** a strict new codec would
  quarantine authorless Threads and a compatibility fallback would reintroduce
  ambiguity. Make the manual installed/dev userData reset an explicit cutover
  prerequisite, verify fresh stores in packaged and development smoke tests, and
  ship no fallback, rewrite, or automatic deletion behavior.
- **Key consumption regression:** calling `preventDefault` before the history
  owner proves it can act would break multiline cursor movement and IME/menu
  behavior. Keep menu and IME ahead of history with no callback, return an
  explicit `performed | declined` effect only after history is offered, consume
  only the former, and cover both ownership and fallthrough in unit and Chromium
  E2E tests.
- **History drift during live updates or rollback:** anchor browsing by Item ID,
  retain the prior ordinal only for a missing anchor, and test the exact
  successor/predecessor/scratch rule at every boundary.
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
during an active Turn. `ThreadInputAuthor` is a required rich canonical field,
reader authority is minted only at renderer admission, every privileged caller
states its non-reader author, and transcript trust and history use the same
classifier. The installed and clone-scoped stores are manually reset before
cutover validation, and the new runtime accepts only the required-author schema.
Menus and IME retain earlier ownership without invoking history; an offered
semantic history action consumes its key only when performed. The feature ships
with all protocol, storage, and renderer consumers in one implementation PR.
Reverse search and alternate keymaps require a separate product review.

## Implementation checklist

- [ ] Add `ThreadInputAuthor`, privileged-author admission types, the required
  canonical Item field, one strict codec graph, separate renderer/
  privileged admission contracts, exact producer attribution, retry propagation,
  fork preservation, shared classifier, and focused codec/lifecycle/
  collaboration/feature coverage.
- [ ] Apply the same strict decoder at rollout and projection read/write seams;
  cover every Item-bearing notification, SQLite row read, rebuild,
  missing-rollout restoration, missing/invalid-author rejection, and Thread
  quarantine boundaries. Verify the one-time manual installed/dev store reset
  and absence of compatibility or automatic-deletion code.
- [ ] Convert transcript speaker grouping, reader bubble placement, and Edit
  eligibility to canonical author; delete `hostAuthoredEvent`,
  `hostNoticeItemId`, and first-user-Item inference before adding history.
- [ ] Add the pure history selector/reducer and focused renderer tests covering
  author filtering, entry ordering, bounds, scratch, working copies, exact
  removed-anchor reconciliation, dynamic entry addition, and reset.
- [ ] Extend the editor snapshot/materialization seam and add the semantic
  `performed | declined` action route with layout-aware arrow handling, no-call
  menu/IME ownership, and callback-decline native fallthrough.
- [ ] Integrate Thread-owned session bundles and attachment retention/cleanup in
  `ThreadView`, including visible-only budgets, the in-flight admission guard,
  atomic marker/resource/tray swaps, and an opaque current-resource adapter that
  neither copies bytes nor interprets the digest-shaped ID.
- [ ] Add Agent Thread E2E for single-line recall, multi-line and soft-wrap
  boundaries, menu/IME ownership, modifier and callback-decline fallthrough, all
  canonical author kinds, fresh-store strict decoding, transcript speaker/Edit
  trust, deterministic rollback reconciliation, structured resend, Thread
  isolation, queued admission safety, pending paste safety, tray projection,
  hidden-slot budgets, active-Turn attachment steer, refused-send restoration,
  and managed-resource cleanup.
- [ ] Fold the shipped behavior into `docs/spec/agent-core.md`,
  `docs/spec/agent-model-runtime.md`, and
  `docs/spec/agent-thread-rendering.md`, then verify no visual or focus
  regression in light and dark mode.
- [ ] Run `bun run typecheck`, `bun run test:core`, `bun run test:renderer`,
  `bun run test:e2e -- tests/e2e/agent-thread.spec.ts`,
  `bun run docs:check`, and `git diff --check`.
