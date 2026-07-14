# Queued Steer Consumption

## Goal

Remove the queued-steer preview as soon as the runtime consumes that steer into
the visible conversation transcript, even while the current Run remains active.
The composer must continue to expose edit and cancel controls while the steer is
actually pending.

This is one complete feature in one PR.

## Non-goals

- Change pi-agent-core steering or follow-up queue semantics.
- Add or change an IPC, core command, event, or projection contract.
- Restyle the queued-steer preview or transcript message bubble.
- Make follow-up queue state durable.

## Design

### Consumption identity

Keep queued-steer UI state in `AgentChatPanel`, but store more than the display
text. Each queued value records the current conversation plus the identity and
source sequence of the latest visible user message when the steer was accepted.

Derive the latest visible user-message signal from the runtime entries. A steer
is consumed only when a later user message appears in the same conversation and
its complete text matches the queued value. The identity/source-sequence baseline
prevents an older identical message from clearing a newly queued steer.

The comparison remains renderer-local because the main process already emits the
consumed steer as a normal `user_message.created` projection. No new protocol
state is required.

### State transitions

- Queue: show the preview immediately and retain its consumption baseline.
- Append: replace the pending queue value with the combined text and a fresh
  baseline, matching the runtime's replace-before-steer behavior.
- Consume: clear the preview when the matching later user message enters the
  transcript, without waiting for the Run to settle.
- Reject: clear only the exact queued state associated with the rejected request,
  so an older async response cannot erase a newer steer.
- Cancel or edit: keep the existing runtime queue-clear behavior.
- Run settle or conversation switch: clear any remaining local preview as a
  lifecycle fallback.

The consumption effect depends on primitive latest-user identity/text values, not
the full streaming entry collection, so token updates do not repeatedly trigger
state work.

### Verification

Extend the agent composer E2E flow to keep the Run active while projecting the
queued steer as a new user transcript message. Assert that the preview remains
before consumption, disappears after consumption, and the composer no longer
offers append-to-steer copy. Existing stop/steer behavior remains covered.

Update the steering specification to state that the editable preview represents
only an unconsumed runtime queue item.

## Open questions

None.

## Expected files

- `src/renderer/ui/agent/AgentChatPanel.tsx`
- `tests/e2e/agent-composer.spec.ts`
- `docs/spec/agent-pi-mono-implementation.md`
