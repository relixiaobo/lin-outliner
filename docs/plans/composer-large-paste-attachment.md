# Oversized Composer Paste Attachments

## Goal

Use the Claude Chat interaction model to keep the Agent composer responsive: one large
plain-text paste becomes one removable `pasted-content*.txt` attachment without
entering ProseMirror. Small pastes remain editable text until the complete draft
reaches a calibrated hard budget.

This is **one complete feature in one PR**: admission, pending/error behavior, managed
storage, cleanup, specs, and focused tests ship together.

## Non-goals

- No Core/IPC/provider-format change, Outliner change, or per-Thread draft registry.
- No truncation, splitting, summarization, preview excerpt, body prompt injection,
  duplicate-paste suppression, or conversion of existing composer text.
- No increase to current attachment/resource quotas and no identical-byte deduplication
  guarantee.

## Design

### Admission

**FR-1.** A pure renderer helper counts incoming UTF-16 units/line breaks and the
projected inline draft (`document - selection + paste`, including reference atoms).
Per-paste thresholds choose attachment conversion; aggregate budgets only guard inline
text, so a small paste never unexpectedly becomes a file.

| Incoming paste | Projected inline draft | Outcome |
| --- | --- | --- |
| Above 8 Mi UTF-16 code units | Any | Reject before encoding; ask the user to save and attach a `.txt` |
| Over either per-paste threshold | Any | Admit one managed `.txt` attachment |
| Within both thresholds | Within aggregate budgets | Insert editable text |
| Within both thresholds | Over either aggregate budget | Reject; ask the user to send or remove content |

Electron calibration covers long-line, newline-dense, repeated, and
selection-replacement pastes. The 8 Mi `text.length` ceiling may only be lowered.
Classification performs no parsing, encoding, hashing, or ProseMirror construction;
no rejected path inserts the body.

### Pending, recovery, and multiple pastes

**FR-2.** An admitted paste replaces its selection with a fixed-size renderer-only
request-id atom; the body stays outside ProseMirror and canonical draft content. Send
is disabled while pending. The existing serialized queue uploads, rechecks eligibility
and the six-item limit, then replaces that atom in place.

**FR-3.** Only synchronous rejection may say the source remains on the clipboard.
Later upload/quota/cancellation/eligibility failure restores the replaced slice and
says only that the paste was not inserted. Removal cancels work and discards unowned
resources.

**FR-4.** Names are monotonic within the mounted draft: `pasted-content.txt`,
`pasted-content-2.txt`, then `pasted-content-3.txt`; failed or removed ordinals are not
reused. Rapid and identical pastes remain separate ordered attachments and each uses a
slot. The current upload path may store identical bytes separately under their distinct
names. Send/clear resets naming; rail collapse preserves the draft; Thread switch
keeps current discard, abort, cleanup, and reset behavior.

### Storage and Agent meaning

**FR-5.** Existing main admission owns quota, digest, publication, and cleanup. Bytes
live below `userData/agent/payloads`; execution exposes a readable copy below
`userData/agent-scratch/agent-attachments`, never the workspace. The attachment has no
`extractedText`; projection exposes its reserved name, metadata, path, and file-tool
guidance, so the Agent recognizes pasted content but reads the body only on demand.

### Surface and collision result

Implementation touches `ThreadComposerEditor.tsx`, `ThreadView.tsx`, one helper,
composer messages/CSS, focused renderer/E2E tests, a calibration probe, and Agent
Thread/model-runtime specs; not Core, IPC, dependencies, `docs/TASKS.md`, or
`CHANGELOG.md`.

No board item, active plan, or open PR claims the behavior. #575's overlap is merged.
#582 overlaps only `agent-model-runtime.md`; implementation starts after it lands and
this branch syncs with `main`.

## Risks

- Chromium allocates the clipboard string before classification; the design removes
  DOM amplification and bounds encoding, not that initial allocation.
- Async settlement must use request-id atoms, not stale numeric positions.
- Identical pastes may duplicate managed bytes; existing attachment/Thread quotas bound
  this accepted tradeoff.

## Acceptance Cases

- **AC-1:** Large pastes attach, fitting small pastes stay inline, aggregate overflow
  rejects, and no rejected body enters composer DOM.
- **AC-2:** Pending uploads block Send and settle at their original structured position.
- **AC-3:** Synchronous and asynchronous failures use the distinct recovery contracts
  above and leave no orphaned resource.
- **AC-4:** Rapid/identical pastes keep ordered names and separate slots; submitted
  attachments expose source meaning and file access without injecting their body.

## Open questions

None.

## Verification

Run `bun run typecheck`, `bun run test:renderer`, focused Agent Thread E2E,
`bun run docs:check`, and `git diff --check`; visually verify pending/error states in
light, dark, reduced-motion, and keyboard-focus modes.
