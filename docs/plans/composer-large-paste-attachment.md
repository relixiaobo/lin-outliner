# Oversized Composer Paste Attachments And Unified Attachment Tray

## Goal

Keep the Agent composer responsive: large plain-text pastes become removable
`pasted-content*.txt` attachments without entering ProseMirror, while fitting pastes
remain editable. Every staged file appears in one tray and keeps an inline marker at
its authored message position.

This is **one complete feature in one PR**: admission, pending/error behavior, managed
storage, the unified tray, cleanup, specs, and focused tests ship together.

## Non-goals

- No Core/IPC/provider-format or Outliner change, per-Thread draft registry, quota
  increase, or identical-byte deduplication guarantee.
- No truncation, splitting, summarization, full-body prompt injection, duplicate
  suppression, or conversion of existing text.
- No new preview engine; reuse shared previews, thumbnails, and semantic fallbacks.

## Design

### Admission

**FR-1.** A pure renderer helper counts incoming UTF-16 units/line breaks and projected
inline content (`document - selection + paste`, including reference atoms). Per-paste
thresholds choose conversion; aggregate budgets only guard inline text.

| Incoming paste | Projected inline draft | Outcome |
| --- | --- | --- |
| Above 8 Mi UTF-16 units | Any | Reject before encoding; ask the user to save and attach a `.txt` |
| Over either per-paste threshold | Any | Admit one managed `.txt` attachment |
| Within both thresholds | Within aggregate budgets | Insert editable text |
| Within both thresholds | Over either aggregate budget | Reject; ask the user to send or remove content |

Electron calibration covers long-line, newline-dense, repeated, and replacement pastes;
the 8 Mi ceiling may only be lowered. Rejection performs no parsing, encoding, hashing,
or ProseMirror construction.

### Pending, recovery, and multiple pastes

**FR-2.** Admission replaces the selection with a fixed-size request atom. The serialized
upload queue rechecks eligibility and the six-item limit, then settles it in place.
Send stays disabled while any upload is pending.

**FR-3.** Only synchronous rejection may mention the clipboard. Later upload, quota,
cancellation, or eligibility failure restores the selection, says the paste was not
inserted, and discards unowned resources.

**FR-4.** Draft-local names increase from `pasted-content.txt` to
`pasted-content-2.txt` and are never reused. Rapid or identical pastes remain separate
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
| Image or existing thumbnail | Thumbnail |
| Generated pasted text | At most three visual lines and 256 UTF-16 units |
| Text/code, PDF, Office, spreadsheet, presentation, audio/video, archive, or generic file | Semantic icon, name, type, and formatted size; use an existing thumbnail when available |
| Directory | Folder treatment; never imply its contents were read |

Eligible items open the shared preview; other states remain identifiable/removable. The
tray is a fixed-height horizontal list that never wraps. At the 280px rail minimum,
stable tiles show one complete item plus the next-item affordance. Native scrolling and
edge chevrons reveal overflow; Left/Right navigates and Enter opens. New items reveal
without taking editor focus, rail collapse preserves scroll, and resize keeps the
focused item visible. The six-item cap needs no collapse or `+N` state.

### Storage and Agent meaning

**FR-5.** Existing main admission owns quota, digest, publication, and cleanup. Bytes
live under `userData/agent/payloads`; execution exposes only a scratch copy. Generated
paste files have no `extractedText`: the Agent receives metadata/path guidance and reads
the body on demand.

### Surface and collision result

Implementation touches the composer editor/view, classifier, attachment-tray component,
messages/CSS, focused renderer/E2E tests, calibration probe, and Agent specs; not Core,
IPC, dependencies, `docs/TASKS.md`, or `CHANGELOG.md`.

The board lists this plan as a P2 draft; no open PR claims its implementation. Open PR
#584 is disjoint, and the required #575/#582 contracts are merged.

## Risks

- Clipboard allocation precedes classification; this bounds DOM/encoding amplification,
  not initial allocation.
- Async settlement must use request IDs, not stale numeric positions.
- Identical paste resources may duplicate bytes, bounded by existing quotas.
- Tray and marker state must derive from one identity/draft to prevent drift.

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
  caret, removal from either representation synchronizes without orphaned data, and six
  attachments remain reachable without wrapping at the 280px rail minimum.

## Open questions

None.

## Verification

Run `bun run typecheck`, `bun run test:renderer`, focused Agent Thread E2E,
`bun run docs:check`, and `git diff --check`; visually verify light/dark, pending/error,
reduced-motion, keyboard-focus, narrow-width, and six-attachment states.
