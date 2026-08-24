# Oversized Composer Paste Attachments And Unified Attachment Tray

## Goal

Keep the Agent composer responsive: large plain-text pastes become removable
`Pasted*.txt` attachments without entering ProseMirror, while fitting pastes
remain editable. Every staged file appears in one tray and keeps an inline marker at
its authored message position.

This is **one complete feature in one PR**: admission, pending/error behavior, managed
storage, the unified tray, cleanup, specs, and focused tests ship together.

## Non-goals

- No Core command/protocol/codec, IPC/provider-format, or Outliner change; no per-Thread
  draft registry, managed-storage quota increase, or identical-byte deduplication
  guarantee.
- No truncation, splitting, summarization, full-body prompt injection, duplicate
  suppression, or conversion of existing text.
- No new preview engine; reuse shared previews, thumbnails, and semantic fallbacks.

## Design

### Admission

**FR-1.** A pure renderer helper measures incoming UTF-8 bytes/line breaks and projected
inline content (`document - selection + paste`, including reference atoms and UTF-16
units). Per-paste thresholds choose conversion; aggregate budgets only guard inline text.

| Incoming paste | Projected inline draft | Outcome |
| --- | --- | --- |
| Above 8 Mi UTF-16 units | Any | Reject before encoding; ask the user to save and attach a `.txt` |
| At least 4 KiB UTF-8 bytes or over 2,000 normalized line breaks | Any | Admit one managed `.txt` attachment |
| Within both thresholds | Within aggregate budgets | Insert editable text |
| Within both thresholds | Over either aggregate budget | Reject; ask the user to send or remove content |

Electron calibration covers long-line, newline-dense, repeated, and replacement pastes;
the selected individual thresholds are 4 KiB UTF-8 bytes and 2,000 normalized line
breaks, while aggregate editable-draft limits are 256 Ki UTF-16 units and 8,000 inline
atoms. The byte threshold matches Claude Chat's current pasted-text boundary. The 8 Mi
ceiling may only be lowered. Rejection performs no parsing, encoding, hashing, or
ProseMirror construction.

### Pending, recovery, and multiple pastes

**FR-2.** Admission replaces the selection with a fixed-size request atom. The serialized
upload queue rechecks eligibility, the 20-attachment message limit, and the 10-image
subset limit, then settles it in place. Button and keyboard submission share one guard
that refuses Send while any upload is pending.
Renderer admission rejects known count overflow immediately. Main-process turn admission
normalizes image observations, rejects a normalized prompt-image total over 24 MiB, and
preserves the complete draft on failure. The existing 2 GiB per-attachment and 8 GiB
per-Thread managed-storage limits remain unchanged.

**FR-3.** Only synchronous rejection may mention the clipboard. Later upload, quota,
cancellation, or eligibility failure restores the selection and any attachment ownership
carried by replaced markers, says the paste was not inserted, and discards unowned resources.

**FR-4.** Draft-local names increase from `Pasted.txt` to `Pasted-2.txt` and are never
reused. Rapid or identical pastes remain separate
ordered slots. Send/clear resets naming; rail collapse preserves it; Thread switch
keeps current discard and cleanup behavior.

### Unified attachment tray

**FR-6.** A tray above the editor shows every staged `ThreadAttachmentContent`: chosen,
dropped, clipboard, local, directory, and generated-paste inputs. It is an inventory,
not a second attachment; inline markers control message position and tray order. A
pending tile/atom share a request ID, then settle onto one `attachmentId`. Removing
either removes both and releases only resources with no remaining owner.

Hover/focus on a remove control gives its marker/request atom a neutral deletion preview
without changing editor selection. Leave, blur, Escape, or cancellation clears it;
activation removes both. Touch relies on an accessible "Remove file and message
reference" label.

| Content | Tray presentation |
| --- | --- |
| Image or existing thumbnail | Edge-to-edge thumbnail |
| Generated pasted text | Whitespace-collapsed continuous excerpt of at most three visual lines and 256 UTF-16 units above a neutral `Pasted` / pending-status label |
| Text/code, PDF, Office, spreadsheet, presentation, audio/video, archive, or generic file | Wrapping name and formatted size above a compact semantic type label/icon |
| Directory | Folder treatment; never imply its contents were read |

Eligible items open the shared preview; other states remain identifiable/removable. The
tray is a fixed-height horizontal list of preview-first 176 x 112 px cards with an 8 px
gap that never wraps. Its card-height viewport keeps a straight overflow cut, softened by
a narrow tokenized inner shadow only on edges with more content. At the 280px rail minimum,
stable cards show one complete item plus the next-item affordance within the composer's
trailing inset. The visual scrollbar stays hidden;
native horizontal scrolling and inset edge chevrons reveal overflow, Left/Right
navigates, and Enter opens. New items reveal
without taking editor focus, rail collapse preserves scroll, and resize keeps the
focused item visible. All 20 allowed attachments remain individually reachable; the tray
does not collapse them into a `+N` state. The first card's top and inline-start offsets,
plus the tray's following margin, share the composer inset token.

Because the card already previews the attachment, hover only deepens its existing 1 px
neutral boundary without changing thickness and reveals the remove control; it does not
open the inline-reference hover preview or a native title tooltip. Activating the card
opens the shared full preview. The remove control is unboxed and keeps an equal
radius-derived inset from the card's top and trailing edges; hovering or focusing it
deepens only the glyph and highlights the linked marker, and leaving it clears that
preview before deletion.

### Storage and Agent meaning

**FR-5.** Existing main admission owns quota, digest, publication, and cleanup. Bytes
live under `userData/agent/payloads`; execution exposes only a scratch copy. Generated
paste files have no `extractedText`: the Agent receives metadata/path guidance and reads
the body on demand.

### Surface and collision result

Implementation touches the composer editor/view, classifier, attachment-tray component,
attachment admission limits, main-process image admission, messages/CSS, focused
renderer/core/E2E tests, calibration probe, and Agent specs; not IPC, dependencies,
`docs/TASKS.md`, or `CHANGELOG.md`.

The board lists this plan as a P2 draft. Open PR #584 is disjoint. PR #585 currently
changes only its input-history plan, but its future implementation will overlap
`ThreadComposerEditor.tsx`, `ThreadView.tsx`, composer CSS/tests, and Agent specs; this
feature claims those surfaces first, so #585 must coordinate and rebase before building.
The required #575/#582 contracts are merged.

## Risks

- Clipboard allocation precedes classification; this bounds DOM/encoding amplification,
  not initial allocation.
- Async settlement must use request IDs, not stale numeric positions.
- Identical paste resources may duplicate bytes, bounded by existing quotas.
- Tray and marker state must derive from one identity/draft to prevent drift.
- Count limits can be checked before upload, but the 24 MiB prompt-image limit is exact
  only after main-process normalization; a rejected Send must restore the entire draft.

## Acceptance Cases

- **AC-1:** Large pastes attach, fitting small pastes stay inline, aggregate overflow
  rejects, and no rejected body enters composer DOM.
- **AC-2:** Pending uploads block Send and settle at their original structured position.
- **AC-3:** Synchronous and asynchronous failures follow their distinct recovery rules
  and leave no orphaned resource.
- **AC-4:** Rapid/identical pastes retain ordered names, separate slots, and on-demand
  file access without body injection.
- **AC-5:** Every attachment source/category shows one tray item and inline marker for
  the same identity; preview and fallback states work, pending tiles do not shift
  layout, remove-control hover/focus previews the paired deletion without moving the
  caret, removal from either representation synchronizes without orphaned data, and all
  20 attachments remain reachable without wrapping at the 280px rail minimum.
- **AC-6:** A message admits at most 20 attachments and at most 10 images. Main admission
  rejects normalized prompt-image observations above 24 MiB without losing the draft;
  the 2 GiB per-attachment and 8 GiB per-Thread managed-storage limits still apply.

## Open questions

None.

## Verification

Run `bun run typecheck`, `bun run test:renderer`, focused Agent Thread E2E,
`bun run docs:check`, and `git diff --check`. Build `scripts/probe-composer-paste.ts`
for Electron and record classification, DOM construction, next-frame, and next-edit
latency. Visually verify light/dark, pending/error, reduced-motion, keyboard-focus,
narrow-width, and 20-attachment states.
