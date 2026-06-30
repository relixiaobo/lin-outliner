# Clear Context Boundary

## Goal

Ship `/clear` as a model-context boundary inside the current Channel.

When the user sends `/clear`, Tenon appends a dedicated transcript boundary row
that says `Context cleared.`. Messages before that boundary remain durable
conversation history: users can still see them in the transcript, search them,
and retrieve them explicitly through `past_chats`. They are no longer part of
the default model context for later turns. `/compact` remains the summary-based
continuation path; `/clear` is a fresh start with no retained summary.

This is one complete feature in one PR.

## Non-goals

- Do not delete, rewrite, or hide pre-clear transcript history.
- Do not create a new Channel or change Channel membership/settings.
- Do not summarize old context, restore recent files, or preserve invoked-skill
  bodies as `/compact` does.
- Do not make `/clear` a mutable skill; it is a built-in runtime command handled
  before slash-skill resolution.
- Do not change Dream-channel behavior.

## Design

Use a persisted event-log boundary, not an in-memory message-array reset.
cc-2.1 clears by regenerating the session id and emptying the current message
array, while its compact path uses a `compact_boundary` marker plus
model-facing slicing. Tenon should copy the boundary invariant, not the new
session model, because Channels are durable event-sourced conversations.

Add a `context.cleared` event with a `messageId` and a source range covering the
active path before the clear. The runtime appends a new root user/system message
with visible text `Context cleared.` and selects it as the active leaf. Later
user messages naturally attach under that root, so `getAgentEventActivePath()`
starts at the clear boundary and excludes earlier messages from ordinary model
context assembly.

Render `context.cleared` as a dedicated boundary row, parallel to compaction and
Dream rows, rather than as a normal user bubble. The boundary row owns a render
entity with the event id, message id, source range, and created-at timestamp.
The clear root message remains available to pi-message derivation, but the
renderer displays only the boundary row.

Visible transcript expansion should mirror compaction without a summary. When
`getAgentEventVisibleTranscript()` encounters a clear boundary, it expands the
source range as archived rows before the boundary row. This keeps the old
conversation readable and searchable while preserving the active-path boundary.
Nested boundaries should use the same recursion guard pattern as compaction.

`past_chats` should continue to use visible-transcript filtering. A search/read
with `includeCurrentConversation: true` can find and read pre-clear messages
because they remain visible through archived transcript expansion. The default
current-conversation exclusion remains unchanged.

Runtime slash handling should list `/clear` beside `/compact` and dispatch it
before slash-skill lookup when there are no attachments. It should be rejected
while a Channel run is active by the same settled-transcript rule used for
edit/retry/regenerate, rather than being queued as steering.

After clearing, reset conversation-scoped model context caches that would
incorrectly carry hidden state across the boundary: run permission rules,
queued skill-listing reservations, user-view context reminder state, recent file
read freshness, tool-result budget state, auto-compact failure counters, and
conversation skill/listing state. Do not reset durable Channel metadata or
delete event-store payloads.

## Implementation Surface

- `src/main/agentRuntime.ts`: `/clear` command listing and dispatch, append clear
  boundary event/root message, reset per-context runtime state.
- `src/core/agentEventLog.ts`: persisted event type, replay record, active/visible
  transcript behavior.
- `src/core/agentRenderProjection.ts`: clear boundary row/entity.
- Agent transcript renderer/i18n: display the boundary text.
- Tests: slash listing/composer handoff, event replay/projection, runtime model
  active path after clear, and `past_chats` search/read of pre-clear messages.
- Specs: `docs/spec/agent-skills.md` and
  `docs/spec/agent-event-log-rendering.md`.

## Risks

- The persisted event shape is a format surface; define it once and keep the
  reader strict.
- The key invariant is easy to regress: old messages must stay visible to
  transcript/history code but absent from default model context.
- If runtime state reset is too broad, it may discard useful Channel settings;
  if too narrow, hidden reminders or permission state may leak across the clear.

## Open Questions

- Should the UI label include a history hint, or stay exactly `Context cleared.`
  as the whole visible row?
- Should multiple consecutive `/clear` commands create multiple boundary rows,
  or should a second clear immediately after a clear no-op?
- Should `/clear` be available when `compactEnabled` is false, or should it have
  an independent runtime setting?
