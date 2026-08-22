# Oversized Composer Paste Attachments

## Goal

Keep the Agent composer responsive when pasted plain text would make the complete
ProseMirror document exceed a calibrated character or inline-node budget. Such text
never enters the editor: an eligible paste becomes a managed UTF-8 `.txt` attachment
at its selection, while an unsafe-to-convert paste is rejected before encoding.

This is shape **(a): ONE complete feature in one PR**, including calibration,
pending/error behavior, cleanup, specs, and focused tests.

## Non-goals

- No Core command, attachment protocol/codec, preload IPC, or provider-format change;
  no clipboard `origin` field.
- No truncation, splitting, summarization, preview excerpt, or automatic body injection
  into the model prompt.
- No Outliner change and no increase to the existing six-item composer, 2 GiB manual
  resource, or 8 GiB per-Thread limits.
- No per-Thread draft registry. Thread switching keeps its current discard behavior.

## Design

### Projected-document admission

**FR-1.** A pure `composerPasteAdmission.ts` helper classifies:

```text
current document - current selection + incoming plain text
```

It compares projected UTF-16 code units and projected ProseMirror inline-node count,
including normalized line breaks and existing reference atoms. Repeated near-limit
pastes therefore cannot grow the document beyond the calibrated budget, while a paste
replacing a large selection may stay inline when the result fits.

The feature PR calibrates both limits in Electron with long-line, newline-dense,
mixed, repeated-paste, and selection-replacement corpora. A developer probe records
paste-to-frame and next-edit latency plus DOM-node count; deterministic tests lock the
chosen boundaries. Classification performs only bounded counting before deciding: no
HTML parse, encoding, hashing, or ProseMirror construction occurs first.

### Three outcomes

**FR-2.** Clipboard files retain the current attachment path. Non-empty `text/plain`
uses this table:

| Projected document | Incoming text | Outcome |
| --- | --- | --- |
| Within editor budgets | Any fitting paste | Existing editable-text insertion |
| Over either budget | At most 8 Mi UTF-16 code units | Managed `.txt` admission |
| Over either budget | Above 8 Mi code units | Reject before `File` construction; preserve the draft and ask the user to save as `.txt` and attach it |

The automatic-conversion ceiling is checked with `text.length`; it bounds the source
string to about 16 MiB and worst-case UTF-8 bytes to 24 MiB. Calibration may lower but
not raise it in this PR. Manual `.txt` files retain the 2 GiB attachment path. Every
unavailable, limit, quota, duplicate, cancellation, and failure branch forbids fallback
insertion into the editor.

### Pending state and serialized admission

**FR-3.** An eligible oversized paste replaces its selection with one fixed-size,
renderer-only pending atom containing only a request id and filename. The body stays
outside ProseMirror/canonical draft content, and Send is disabled while any request is
pending. `ThreadComposerEditor` retains the replaced slice by request id.

`ThreadView` creates the UTF-8 `File` and uses the existing serialized composer queue
and chunked `attachment-upload/*` path. Success replaces that exact atom with a normal
`fileReference`; failure restores the replaced slice and announces that the body
remains on the clipboard. Removing an atom cancels/skips its work and discards any
unowned completed resource.

The queue rechecks provider/Turn eligibility and six-item capacity inside every
operation, so rapid text pastes interleaved with picker, file-paste, drop, or mention
admissions cannot race the limit. The seventh attachment starts no upload and inserts
no text.

### Order, naming, deduplication, and lifecycle

**FR-4.** Pending atoms are inserted immediately and settled by request id, preserving
their positions and event order after later caret movement. Eligible events receive
monotonic names within the mounted draft: `User pasted text.txt`, `User pasted text
2.txt`, then `User pasted text 3.txt`. Ordinals are not reused after removal,
duplicate, cancellation, or failure. Send/clear resets them.

Collapsing the Agent rail preserves the mounted draft. Switching Threads follows
current behavior: unmount discards the unsent draft, aborts pending work, cleans owned
managed resources, and resets naming. Main's completed resource digest is the duplicate
key; duplicate admission restores the replaced slice, discards its unowned result, and
uses no additional slot or durable storage. Renderer code does not retain previous
large strings or compute another whole-buffer hash.

### Storage and Agent meaning

**FR-5.** Existing main admission remains the quota, SHA-256, atomic-publish, filename,
and cleanup authority. Bytes live in the Thread resource store below
`userData/agent/payloads`; execution exposes an isolated copy below
`userData/agent-scratch/agent-attachments`, never the workspace or repository.

The composer does not set `extractedText`. Existing projection gives the Agent the
generated name, MIME type, byte length, readable path, file marker, and
`file_read`/`file_grep` guidance. The body enters context only if the Agent reads it.

### Implementation surface and collision result

- `ThreadComposerEditor.tsx`, `ThreadView.tsx`, the new helper, `thread.css`, and both
  composer message catalogs.
- Helper tests, a calibration probe, focused `agent-thread.spec.ts` coverage, and
  updates to `agent-thread-rendering.md` plus the existing attachment wording in
  `agent-model-runtime.md`.
- No Core protocol/command/codec, main/preload IPC, dependency/build, `docs/TASKS.md`,
  or `CHANGELOG.md` edit.

Collision check found overlap with #575 across renderer, messages, CSS, specs, and E2E.
#575 is now in `main`; implementation uses that merged surface. No board item, active
plan, or open PR claims the same oversized-composer-paste behavior.

## Risks

- Chromium allocates the clipboard string before Tenon can classify it; this removes
  DOM amplification and bounds encoding, not that initial allocation.
- Async settlement must locate request-id atoms, never stale numeric positions.
- Pre-enqueue checks alone race other attachment sources; inside-queue checks are
  required.

## Acceptance Cases

- **AC-1:** Repeated near-limit paste and selection replacement use the projected
  complete document and never cross either editor budget.
- **AC-2:** An eligible oversized paste blocks Send, then becomes one managed `.txt`
  reference at the same structured position.
- **AC-3:** Above-ceiling text and every unavailable/failure path perform no unsafe
  conversion and insert no clipboard body; recovery copy is announced.
- **AC-4:** Rapid/interleaved admissions preserve positions, ordered stable names,
  digest deduplication, the six-item limit, and resource cleanup.
- **AC-5:** Thread switch discards/cleans/reset; rail collapse preserves. Submitted
  content is an ordinary attachment without `extractedText`, and the provider receives
  metadata/path/tool guidance rather than the body.

Run `bun run typecheck`, `bun run test:renderer`, focused Agent Thread E2E,
`bun run docs:check`, and `git diff --check`, plus light/dark accessibility checks.

## Open questions

None. Main review ratifies the 8 Mi automatic ceiling and current Thread-switch discard
behavior; calibration selects only lower editor budgets and may lower the ceiling.
