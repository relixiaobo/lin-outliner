# Agent Delegated Failure Truth

**Shape:** ONE complete delegated-execution experience in one PR.

## Goal

Make every delegated generation report immutable execution outcome and factual
direct-parent notification state without rewriting the stable Agent's liveness
or claiming that delivery means handling, acceptance, or task completion.

The same PR closes the original blank delegated-transcript regression through
the canonical authorship/renderability owners shipped in #587.

## Non-goals

- No automatic child retry/resume or root task-outcome inference.
- No second settlement ledger, notification queue, renderer acknowledgement, or
  direct-to-root delivery bypass.
- No `handled`, `used`, `accepted`, or `taskComplete` state.
- No duplicate author classifier, transport-specific visible flag, or blanket
  suppression of machine context.
- No root Turn Continue/Rerun behavior; that belongs to
  `agent-root-turn-recovery`.

## Design

### Existing delivery remains authoritative

`SubagentExecutionLedger` and `SubagentCollaboration` remain the only child
settlement and direct-parent notification owners. A terminal background
generation writes one durable notification row, remains pending while the
parent is busy, survives restart, and enters the direct parent at its next valid
idle boundary. Failure and success use the same path.

### Immutable generation receipt

Project one receipt keyed by stable Agent ID and generation from existing
execution rows, child Turn, anchors, and delivered-notification references. It
contains terminal status/duration, bounded actionable error, partial-output
availability, direct-parent identity, notification state, and delivery Turn
reference. It is a projection, not a second persisted record.

Historical spawn/resume anchors and `SubagentReport` read their exact generation
receipt. Resuming the stable Agent may update its live detail header but cannot
rewrite an earlier **This run failed** record into Working or Finished.

### Scope-aware presentation

Stable Agent liveness uses **Working**. Historical generations use **This run
finished/failed/was interrupted/was stopped**. Delivery separately uses
**Waiting to notify {parent}**, **Notifying {parent}**, or **{parent} notified**.
A child failure never derives a root failure; only the root's own canonical Turn
does.

### Blank-transcript closure

Replay the captured failing delivery after #587. Before speaker grouping,
spacing, copy targeting, and accessibility projection, filter every Item for
which `threadItemRendersNothing` is true. If the fixture still produces an empty
speaker, extend that canonical classifier or grouping boundary only. Typed
additional context remains available to model projection and Trajectory while
contributing zero visible/accessibility transcript output.

`ThreadInputAuthor` remains the sole speaker-trust authority and provider role
never establishes reader or Agent authorship.

The boundary applies to every supported author kind rather than only delegated
transport Items. It must continue to classify attachment-only reader messages as
renderable; fixing blank machine context cannot hide visible attachments or add
a second author/visibility rule.

### Dependencies and collisions

`agent-root-turn-recovery` precedes this PR by shared-surface collision order,
not product dependency. Both consume the final Host, Agent large-text, and Agent
resource-lifecycle projection. Repeat the claim check against Cross-Thread and
subagent UI work before implementation.

### Verification

End-to-end fixtures cover busy parent, restart, terminal success/failure/stop/
interrupt, partial output, exactly-once delivery, stable-agent resume, historical
anchor immutability, root-liveness independence, rollout rebuild, renderer
reload, and the original blank-speaker plus attachment-only reader shapes.
Light/dark and accessibility checks verify scoped copy.

### Acceptance criteria

- Every historical generation keeps its exact terminal outcome after stable
  Agent state changes.
- Notification state proves only direct-parent delivery progress.
- Busy-parent and restart paths preserve exactly one pending delivery.
- A failed child cannot make an active root render as failed.
- A content-free Item of any supported author kind creates no speaker, spacing,
  copy target, or accessibility output while retaining typed model context;
  attachment-only reader messages remain visible.

## Open questions

If existing anchors cannot identify a generation unambiguously, add only the
minimum generation identity to the existing canonical projection; do not add a
second outcome record.

If the captured blank-transcript fixture already passes on the merged baseline,
retain it as regression evidence and make no blank-message production change.

## Implementation checklist

- [ ] Replay the original fixture before editing production code.
- [ ] Prove existing settlement/delivery behavior and fix only its authorities.
- [ ] Project immutable generation receipts and scope-aware copy.
- [ ] Close blank output through canonical author/renderability mechanisms.
- [ ] Run core, renderer, Agent E2E, docs, accessibility, and visual checks.
