# Oversized Composer Paste Attachments

## Goal

Prevent the Agent composer from freezing when a user pastes a very large plain-text
payload. Text within a calibrated editor budget keeps the current direct-paste
behavior. Text beyond either the character or projected-node budget never enters the
ProseMirror document; it becomes a managed UTF-8 `.txt` attachment at the original
paste position instead.

The resulting attachment must use the existing Thread resource lifecycle and model
projection. The user sees a normal removable file reference. The Agent sees its name,
MIME type, byte length, execution-lifetime readable path, and the existing `file_read`
guidance, but the pasted body is not copied into the model prompt automatically.

This plan has shape **(a): ONE complete feature in one PR**. Calibration, admission,
pending and failure states, managed-resource cleanup, specifications, and focused
coverage ship together.

## Non-goals

- Do not change `ThreadUserContent`, `ThreadAttachmentContent`, Core commands, codecs,
  preload IPC, or the provider request format.
- Do not add clipboard provenance such as an `origin` field. The generated filename
  provides the user- and model-readable source meaning.
- Do not turn ordinary small pastes into attachments or change the composer's existing
  plain-text newline behavior.
- Do not split one oversized paste into multiple files, summarize it, truncate it, or
  insert a preview excerpt into the editor or prompt.
- Do not place pasted content in the workspace, repository, OS temporary directory, or
  another user-visible folder.
- Do not raise the existing six-attachment composer limit, 2 GiB managed-resource
  limit, or 8 GiB per-Thread resource quota.
- Do not generalize this policy to the Outliner editors in this PR.

## Design

### Admission budget and calibration

Add a pure renderer helper, `composerPasteAdmission.ts`, that classifies a non-empty
`text/plain` clipboard value against two independent limits:

- a UTF-16 code-unit budget protects the single large text-node case; and
- a normalized line-break budget protects the many-`hardBreak` node case.

Classification first checks `text.length`. It scans line breaks only while the text is
within the character budget and stops once the node budget is exceeded. The paste hot
path therefore performs no HTML parsing, UTF-8 encoding, hashing, or ProseMirror node
construction before deciding whether the text is safe for the editor.

The constants are not chosen from intuition. The feature PR adds a developer-run
Electron/Chromium calibration probe covering at least these clipboard shapes:

| Corpus | Pressure measured |
| --- | --- |
| One long line | text-node creation, DOM insertion, layout, and the next edit |
| Short newline-delimited lines | `hardBreak` creation, DOM-node count, layout, and the next edit |
| Mixed paragraphs | representative prose and source-code paste |

The probe records paste-handler duration, paste-to-next-frame latency, DOM-node count,
and latency of the first edit after paste over warm repeated runs on the supported
macOS Electron build. The committed limits take a safety margin below the first corpus
size that produces a user-visible long task or delayed follow-up edit. Timing results
are calibration evidence, not a flaky CI assertion; deterministic unit tests lock the
chosen `limit`, `limit + 1`, CRLF, and newline-dense boundaries.

### Paste decision flow

`ThreadComposerEditor` keeps file-bearing clipboard input on the existing attachment
path. For a non-empty plain-text paste it performs the following synchronous decision
before ProseMirror's default paste can run:

```text
clipboard files present
  -> existing file admission

plain text within both budgets
  -> existing insertPlainTextWithBreaks behavior

plain text exceeds either budget
  -> prevent default
  -> if attachment admission is unavailable, preserve the document and report recovery copy
  -> otherwise insert one fixed-size pending atom at the current selection
  -> enqueue managed text-attachment admission
```

The oversized branch never falls back to inserting the clipboard text into
ProseMirror, including when the provider is unavailable, a Turn is active, the composer
already has six attachments, managed storage is full, upload fails, or the Thread
changes during admission. The error tells the user that the large paste was not
inserted and remains available from the clipboard.

Only `text/plain` participates in this decision. A clipboard event containing files
continues to prefer the file path. Clipboard HTML is not parsed or persisted because
the Agent composer already treats pasted text as plain text.

### Renderer-local pending lifecycle

An accepted oversized paste synchronously replaces the current selection with a
renderer-only `pendingTextAttachment` atom. The atom contains only a request id and
generated display name; it never contains the pasted body and never appears in
`ThreadComposerDraftContent` or canonical history. It renders inline at stable file-
reference dimensions with a compact progress indicator and exposes `aria-busy` plus a
localized accessible name.

`ThreadComposerEditor` retains the replaced ProseMirror slice in an in-memory map keyed
by request id. `ThreadView` owns the corresponding text string only for the lifetime of
the queued admission. The imperative editor boundary can settle a request in exactly
one of three ways:

- **commit:** replace the pending atom in place with the normal `fileReference` atom;
- **reject/fail:** replace it with the slice that was selected before the paste and
  surface localized recovery copy; or
- **user removal:** remove the atom, cancel or skip its queued work, and discard any
  completed resource that canonical history or another retained draft does not own.

Send and slash-command submission are disabled while any pending text attachment
exists. Draft extraction ignores pending atoms, so no partially admitted attachment can
be submitted through keyboard or button races. Thread changes and component teardown
abort active work through the existing attachment lifecycle controller, clear pending
text from renderer memory, and reuse managed-resource cleanup.

### Managed `.txt` creation

For an admitted request, `ThreadView` creates a pathless browser `File` from the exact
clipboard string with `type: 'text/plain'` and UTF-8 bytes. It passes that file through
the existing `attachmentFromBrowserFile` and chunked `attachment-upload/*` path. Main
therefore remains the write, quota, digest-verification, atomic-publication, cleanup,
and filename-sanitization authority.

Persistent bytes live under the existing content-addressed Thread store. In path
terms, that is the `agent/payloads` directory below `userData`, followed by the Thread
id, `resources`, the SHA-256 digest, and the sanitized display filename.

The private payload path never enters renderer content or the provider request. During
execution, the existing materializer creates an isolated readable copy under
the `agent-scratch/agent-attachments` directory below `userData`. This keeps pasted
text out of the workspace while making it available to the Agent's existing
`file_read` and `file_grep` tools.

The composer does not set `extractedText`. Provider projection consequently includes
the existing marker and attachment metadata/tool guidance without injecting the body.
The Agent decides whether and how much to read using the bounded file tools.

### Multiple oversized pastes

Every eligible paste receives a monotonic draft-local ordinal when its pending atom is
inserted:

```text
User pasted text.txt
User pasted text 2.txt
User pasted text 3.txt
```

An allocated ordinal is never reused or applied to another atom after removal,
deduplication, cancellation, or failure; gaps are acceptable. Sending or explicitly
clearing the complete draft starts a new naming sequence. Switching Threads preserves
each retained draft's own sequence through the existing per-Thread UI state.

All oversized-paste requests use the same serialized composer attachment queue as
picker, paste-file, drop, and mention admissions. Pending atoms are inserted
immediately at their respective selections, while upload and commit happen in event
order. Replacing atoms by request id preserves each original paste position even if the
user moves the caret or edits elsewhere before an upload completes.

The generated file is subject to the same shared six-attachment total as every manual
attachment. Capacity is checked when the request is enqueued and rechecked inside the
serialized operation so overlapping file and text admissions cannot exceed the limit.
The seventh attachment is rejected without inserting its body into the editor.

Main's completed `ThreadResourceReference` digest is the duplicate key for pathless
text. If a later paste has the same SHA-256 content as a retained attachment, the new
pending atom is removed, the replaced slice is restored, the newly completed
unreferenced resource is discarded, and transient duplicate feedback is shown. It does
not consume a composer slot or durable duplicate storage. Renderer code does not retain
the first giant string or compute a second whole-buffer hash merely to deduplicate.

### Eligibility, failure, and recovery

Oversized-text attachment admission is available only when ordinary file attachment
admission is available: the Thread has a usable provider, no Turn is active, no
`request_user_input` or Thread-creation transition owns the composer, the draft is
below the attachment limit, and the Thread attachment lifecycle is live.

The parent passes that eligibility into the editor so a disallowed paste is intercepted
before any DOM mutation. Admission revalidates the same facts in the serialized queue;
a state change between paste and execution follows the failure path rather than
committing an attachment that the current composer could not otherwise add.

Failure handling distinguishes user-actionable causes in localized copy:

- attachments are unavailable until provider setup is complete;
- attachments cannot be added while the current Turn is active;
- the draft already contains six attachments;
- the text exceeds the existing per-resource or Thread quota;
- managed upload failed or was canceled; and
- the same content is already attached.

No failure changes authored text outside the original selection. The original
selection is restored when an internally accepted request later fails. The clipboard
remains the recovery source for the oversized pasted body; the error never embeds that
body in React state rendered to the DOM.

### Specifications and implementation surface

Update `agent-thread-rendering.md` with the admission budget, pending lifecycle,
ordering, naming, shared limit, duplicate, and recovery rules. Update
`agent-model-runtime.md` only where needed to state that auto-generated pasted-text
attachments use the existing non-extracted managed-file projection. No design-system
contract changes are expected; any pending styling uses existing composer, neutral
state, spinner, focus, reduced-motion, and contrast tokens.

Expected implementation surface:

- `ThreadComposerEditor.tsx` for synchronous classification, pending atoms, selection
  restoration, and imperative settlement;
- `ThreadView.tsx` for eligibility, naming, serialized admission, commit/dedup/cleanup,
  and Send gating;
- a new pure `composerPasteAdmission.ts` helper and focused renderer unit test;
- English and Simplified Chinese composer messages;
- `thread.css` only for the fixed-size pending presentation;
- a calibration probe plus focused `agent-thread.spec.ts` coverage; and
- current Agent Thread and model-runtime specifications.

The implementation must not modify `src/core/commands.ts`, `src/core/types.ts`, the
Thread attachment codec, `package.json`, or preload/main IPC contracts.

### Verification

Focused tests cover:

- exact character and node-budget boundaries, CRLF normalization, empty text, and a
  newline-dense corpus;
- a below-budget paste remaining editable text with the current newline semantics;
- an above-budget paste never creating a giant text DOM and becoming one managed `.txt`
  reference at the selected position;
- two or more rapid oversized pastes preserving position, order, stable names, and
  Send-disabled pending state;
- interleaved manual-file and oversized-text admissions respecting the shared limit;
- same-content deduplication using the returned digest without a second attachment;
- removal, Thread change, provider unavailability, active Turn, upload failure, and
  quota failure leaving no orphaned managed resource and no giant fallback text; and
- the submitted canonical content containing an ordinary `text/plain` attachment with
  no `extractedText`, while the provider-facing request exposes its readable path and
  `file_read` guidance rather than its body.

Run `bun run typecheck`, `bun run test:renderer`, focused Agent Thread E2E coverage,
`bun run docs:check`, and `git diff --check`. Perform light/dark visual verification of
the pending and error states, including reduced motion and keyboard focus.

### Requirements and acceptance criteria

- **FR-1:** Classify every non-empty Agent-composer plain-text paste against the
  calibrated character and projected-node budgets before constructing ProseMirror
  content.
- **FR-2:** Convert an over-budget eligible paste into one managed UTF-8
  `text/plain` attachment at its original structured-content position.
- **FR-3:** Serialize multiple oversized-paste requests with every other composer
  attachment admission while preserving paste order, position, stable monotonic names,
  and the shared six-attachment limit.
- **FR-4:** Use the completed managed-resource SHA-256 identity to skip duplicate
  pasted content without consuming another durable resource or attachment slot.
- **FR-5:** Keep pending paste content renderer-local, block submission until it
  settles, and clean up queued, canceled, failed, removed, or abandoned resources.
- **FR-6:** Project a successful pasted-text attachment through the existing file
  marker, metadata, readable-path, and tool-guidance contract without setting
  `extractedText` or adding a new protocol field.
- **NFR-1:** No over-budget branch may insert the clipboard body into ProseMirror,
  including every unavailable, capacity, quota, duplicate, cancellation, and failure
  outcome.
- **NFR-2:** Classification work is bounded by the calibrated character budget and an
  early-exit line-break scan; timing measurements remain a developer calibration
  signal rather than a CI pass/fail threshold.

- **AC-1:** Given plain text at both calibrated limits, when it is pasted into an
  eligible composer, then it follows the existing editable-text path; given text one
  unit over either limit, then no giant text node or `hardBreak` set enters the DOM.
- **AC-2:** Given an over-budget paste replacing a selection, when managed admission
  succeeds, then one ordinary file reference named `User pasted text.txt` replaces the
  pending atom at that selection and canonical content contains one `text/plain`
  attachment.
- **AC-3:** Given three rapid eligible oversized pastes at different caret positions,
  when their serialized uploads settle, then their references remain at those
  positions and are named `User pasted text.txt`, `User pasted text 2.txt`, and
  `User pasted text 3.txt` in event order.
- **AC-4:** Given six retained attachments, when another oversized paste occurs, then
  the draft is unchanged, the clipboard body is absent from the DOM, no upload starts,
  and localized limit/recovery feedback is announced.
- **AC-5:** Given the same oversized text is pasted twice, when the second upload
  returns the first content digest, then the second pending atom is removed, its prior
  selection is restored, the unreferenced result is discarded, and only one retained
  attachment and resource remain.
- **AC-6:** Given an accepted oversized paste whose upload fails or whose Thread is
  left, when cleanup completes, then no pending atom, clipboard body, or orphaned
  resource remains; an in-place failure restores the original selection and announces
  recovery copy.
- **AC-7:** Given the successful attachment is submitted, when provider input is
  inspected, then it contains the generated name, MIME type, byte length, readable
  scratch path, and `file_read` guidance, while the pasted body is absent until the
  Agent explicitly reads the file.

## Risks

- The clipboard string necessarily exists in renderer memory before classification;
  this feature removes the larger ProseMirror/DOM/layout amplification but cannot
  change Chromium's clipboard allocation.
- Building a UTF-8 `File` may temporarily coexist with the clipboard string. The
  calibration probe must include upload start responsiveness, and the implementation
  must release the request string immediately after the browser `File` owns it.
- Async settlement can target stale editor positions. Request-id atoms, not stored
  numeric positions, are the settlement authority.
- Queue checks performed only before enqueue can race with manual attachment batches.
  The existing serialized queue and an inside-operation capacity check are both
  required.
- `ThreadView.tsx`, `thread.css`, both composer message catalogs,
  `agent-model-runtime.md`, `agent-thread-rendering.md`, and Agent Thread E2E coverage
  overlap the active Agent trajectory workspace change. Implementation starts only
  after that change lands and this branch rebases on `main`.

## Open questions

None. The PM review should ratify the automatic conversion behavior and calibration
method before implementation; the numeric budgets are calibration output recorded by
the feature PR, not an unresolved product choice.

## Implementation checklist

- Calibrate and commit the character and projected-node budgets with boundary tests.
- Add pure classification and draft-local naming helpers.
- Add the renderer-only pending atom and request-id settlement lifecycle.
- Route oversized paste text through the existing serialized managed attachment path.
- Add shared-limit, digest-deduplication, cancellation, cleanup, and recovery behavior.
- Add localized pending, duplicate, unavailable, limit, quota, and failure copy.
- Update current specifications and focused renderer/E2E coverage.
- Rebase after the overlapping Agent trajectory workspace PR lands, then run the full
  required verification before marking the implementation PR ready.
