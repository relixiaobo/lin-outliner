# Agent Transcript Disclosure Anchor

## Goal

Keep the activated transcript surface visually fixed when a user explicitly
expands or collapses content. Process, reasoning, tool-group, tool-detail,
long-user-message, and image-gallery disclosures must grow or shrink away from
the user's anchor instead of letting bottom follow move the clicked content.

This is shape **(a): one complete feature in one PR**.

## Non-goals

- No change to automatic streaming follow, send-to-top anchoring, Thread switch
  restoration, or virtual-row measurement compensation.
- No change to disclosure persistence, default expansion, transcript ordering,
  or canonical Thread data.
- No scroll anchoring for overlays, Turn Details, inline editors, or automatic
  lifecycle updates that have no user-activated disclosure target.
- No smooth scrolling or layout animation.

## Design

### Explicit disclosure ownership

Treat an explicit transcript disclosure toggle as the owner of the current
layout transaction. Capture a stable element and its viewport top before the
state update, restore it after the React layout commit, and keep that temporary
anchor authoritative while delayed measurements settle. A queued or newly
scheduled bottom pin must not override an active disclosure anchor.

After the anchor settles, retain the existing position-derived follow state.
Later streaming content may therefore continue following when the resulting
geometry remains near the bottom. Wheel, pointer, touch, keyboard, or independent
scroll input continues to cancel the temporary anchor immediately.

When a disclosure grows content above its control and the transcript has less
natural scroll range than the required correction, add only the missing amount as
a transient renderer runway on the transcript content. Keep it outside React state
and exclude it from real-content metrics; collapse, later content, or independent
scroll consumes the runway without moving the activated surface.

Reuse the existing `usePendingDisclosureAnchor` mechanism and transient refs;
do not add React state that rerenders the transcript merely to track a
frame-level interaction.

### Disclosure coverage

The shared `ThreadDisclosureState.toggle` path covers process, reasoning,
tool-group, and tool-detail rows. Long user messages use the same anchor helper
through their local measured disclosure and adopt the same clicked-position
contract instead of the previous bottom-follow exception.

Image galleries require a stable fallback because the `+N` control unmounts
when the gallery expands and the collapse control occupies a different row.
Capture the gallery container as the persistent anchor while retaining the
button as the interaction target. Expansion and collapse must preserve the
gallery's viewport top across the grid-layout replacement.

### Verification

Extend the focused Thread E2E coverage with bottom-positioned disclosures and
assert less than one pixel of anchor movement after multiple animation frames:

- terminal reasoning expansion;
- process, tool-group, and tool-detail expansion through the shared path;
- long user-message Show more / Show less;
- image-gallery Show all / Show fewer.

Retain coverage that user scroll cancels delayed anchor correction, asynchronous
tool output holds its anchor until the read settles, Jump to latest restores
follow, and virtualized transcript measurement compensation remains stable.

Update `docs/spec/agent-thread-rendering.md` so explicit user toggles take
priority over bottom follow for their layout transaction.

## Files

- `src/renderer/agent/components/ThreadView.tsx`
- `src/renderer/agent/components/items/ThreadItemView.tsx`
- `src/renderer/ui/interactions/disclosureScrollAnchor.ts`
- `tests/renderer/disclosureScrollAnchor.test.tsx`
- `tests/e2e/agent-thread.spec.ts`
- `docs/spec/agent-thread-rendering.md`

## Risks

- Suppressing bottom pin too broadly could stop ordinary streaming follow. The
  priority applies only while an explicit disclosure anchor is active.
- A disappearing trigger cannot be re-queried after the update. The image
  gallery uses its persistent container as the anchor.
- Async tool output can outlive the initial restore-frame budget. Preserve the
  existing hold/settle generation checks and user-intent cancellation.
- Virtualized Turn measurement and the disclosure anchor can both adjust
  `scrollTop`. The clicked-element anchor remains final authority for this
  explicit interaction, while the existing row-delta path remains unchanged for
  unrelated measurements.

## Collision Result

PR #467 touched `ThreadView.tsx`, `agent-thread.spec.ts`, and the rendering spec,
but merged into `main` before this branch was created. Open PR #468 touches
`ThreadItemView.tsx` and the same spec for `update_plan` visibility; its intended
hunks are separate from disclosure interaction code. Rebase on its merged result
before marking this PR ready if it lands first.

## Open Questions

None. The PM approved one consistent clicked-position rule for all explicit
transcript expansions on 2026-07-31.
