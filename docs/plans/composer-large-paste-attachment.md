# Oversized Composer Paste Attachments

## Goal

Keep the Agent composer responsive with the Claude Chat interaction model: an
individually large plain-text paste never enters ProseMirror and automatically becomes
one removable UTF-8 `.txt` attachment at its selection. Small pastes remain editable
text unless the complete draft has reached a calibrated hard editor budget.

This is shape **(a): ONE complete feature in one PR**, including calibration,
pending/error behavior, cleanup, specs, and focused tests.

## Non-goals

- No Core command, attachment protocol/codec, preload IPC, or provider-format change;
  no clipboard `origin` field.
- No truncation, splitting, summarization, preview excerpt, or automatic body injection
  into the model prompt.
- No automatic conversion of the existing composer body and no coalescing or
  suppression of repeated paste actions.
- No Outliner change and no increase to the existing six-item composer, 2 GiB manual
  resource, or 8 GiB per-Thread limits.
- No per-Thread draft registry. Thread switching keeps its current discard behavior.

## Design

### Paste admission

**FR-1.** A pure `composerPasteAdmission.ts` helper independently measures the incoming
plain text and the projected inline document (`current document - selection + paste`).
Incoming metrics count UTF-16 code units and normalized line breaks; projected metrics
also count existing reference atoms. The per-paste thresholds decide whether the user
action becomes a file. The aggregate budgets are only a hard safety guard for inline
text, so a small paste never becomes an attachment merely because the draft is long.
Repeated small pastes cannot exceed that guard, while replacing a large selection may
remain inline when the projected result fits.

The feature PR calibrates the per-paste thresholds and aggregate editor budgets in
Electron with long-line, newline-dense, mixed, repeated-paste, and
selection-replacement corpora. A developer probe records paste-to-frame and next-edit
latency plus DOM-node count; deterministic tests lock the chosen boundaries.
Classification performs only bounded counting before deciding: no HTML parse,
encoding, hashing, or ProseMirror construction occurs first.

### Four outcomes

**FR-2.** Clipboard files retain the current attachment path. Non-empty `text/plain`
uses this table:

| Incoming text | Projected inline document | Outcome |
| --- | --- | --- |
| Above 8 Mi UTF-16 code units | Any | Reject before `File` construction; preserve the draft and ask the user to save as `.txt` and attach it |
| Over either calibrated per-paste threshold | Any | Managed `.txt` admission |
| Within both per-paste thresholds | Within both aggregate budgets | Existing editable-text insertion |
| Within both per-paste thresholds | Over either aggregate budget | Reject without changing the draft; ask the user to send or remove content first |

The automatic-conversion ceiling is checked with `text.length`; it bounds the source
string to about 16 MiB and worst-case UTF-8 bytes to 24 MiB. Calibration may lower but
not raise it in this PR. Manual `.txt` files retain the 2 GiB attachment path. Every
unavailable, limit, quota, cancellation, and failure branch forbids fallback insertion
into the editor.

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

### Order, naming, resource sharing, and lifecycle

**FR-4.** Pending atoms are inserted immediately and settled by request id, preserving
their positions and event order after later caret movement. Eligible events receive
monotonic Claude-style names within the mounted draft: `pasted-content.txt`,
`pasted-content-2.txt`, then `pasted-content-3.txt`. Ordinals are not reused after
removal, cancellation, or failure. Send/clear resets them.

Collapsing the Agent rail preserves the mounted draft. Switching Threads follows
current behavior: unmount discards the unsent draft, aborts pending work, cleans owned
managed resources, and resets naming. Each paste action remains a distinct visible
attachment and consumes one of the six composer slots, even when two pasted bodies are
identical. The content-addressed Thread store may reuse the same completed digest and
bytes underneath both attachment identities. Renderer code does not retain previous
large strings or compute another whole-buffer hash.

### Storage and Agent meaning

**FR-5.** Existing main admission remains the quota, SHA-256, atomic-publish, filename,
and cleanup authority. Bytes live in the Thread resource store below
`userData/agent/payloads`; execution exposes an isolated copy below
`userData/agent-scratch/agent-attachments`, never the workspace or repository.

The composer does not set `extractedText`. Existing projection gives the Agent the
generated `pasted-content*.txt` name, MIME type, byte length, readable path, file
marker, and `file_read`/`file_grep` guidance. Because the attachment is part of the
user message and retains this reserved generated name, the Agent can identify it as
user-pasted content without a new protocol field. The body enters context only if the
Agent reads it.

### Implementation surface and collision result

- `ThreadComposerEditor.tsx`, `ThreadView.tsx`, the new helper, `thread.css`, and both
  composer message catalogs.
- Helper tests, a calibration probe, focused `agent-thread.spec.ts` coverage, and
  updates to `agent-thread-rendering.md` plus the existing attachment wording in
  `agent-model-runtime.md`.
- No Core protocol/command/codec, main/preload IPC, dependency/build, `docs/TASKS.md`,
  or `CHANGELOG.md` edit.

Collision check found no board item, active plan, or open PR claiming the same
behavior. The former renderer/spec overlap in #575 is merged. Open PR #582 overlaps
only `agent-model-runtime.md`; implementation starts after it lands and this branch
syncs with `main`.

## Risks

- Chromium allocates the clipboard string before Tenon can classify it; this removes
  DOM amplification and bounds encoding, not that initial allocation.
- Async settlement must locate request-id atoms, never stale numeric positions.
- Pre-enqueue checks alone race other attachment sources; inside-queue checks are
  required.

## Acceptance Cases

- **AC-1:** A paste over either per-paste threshold becomes an attachment even when it
  would fit the current draft; a small paste remains inline when the projected document
  fits, and repeated small pastes are rejected rather than attached at the aggregate
  hard budget. Selection replacement uses the projected result.
- **AC-2:** An eligible oversized paste blocks Send, then becomes one managed `.txt`
  reference at the same structured position.
- **AC-3:** Above-ceiling text and every unavailable/failure path perform no unsafe
  conversion and insert no clipboard body; recovery copy is announced.
- **AC-4:** Rapid/interleaved admissions preserve positions and ordered stable names.
  Two identical pastes remain two attachments backed by one content-addressed payload;
  both count toward the six-item limit and cleanup retains bytes while either remains.
- **AC-5:** Thread switch discards/cleans/reset; rail collapse preserves. Submitted
  content is an ordinary attachment without `extractedText`, and the provider receives
  metadata/path/tool guidance rather than the body.

Run `bun run typecheck`, `bun run test:renderer`, focused Agent Thread E2E,
`bun run docs:check`, and `git diff --check`, plus light/dark accessibility checks.

## Open questions

None. Main review ratifies the Claude-style per-paste conversion rule, 8 Mi automatic
ceiling, identical-paste behavior, and current Thread-switch discard behavior;
calibration selects only lower editor budgets and may lower the ceiling.
