# Thread Completion Layout Stability

## Goal

Keep an Agent Turn geometrically stable when its final response moves from live
streaming to a completed state. The response text must not jump, the process
divider must have equal visual spacing above and below, and the final streaming
Markdown block must retain its React identity when it seals.

This is shape **(a): one complete feature in one PR**.

## Non-goals

- No change to Thread, Turn, or Item protocol shapes.
- No change to process disclosure semantics, action availability, transcript
  ordering, or bottom-follow policy.
- No redesign of message actions, Markdown styling, or the generating shape.
- No attempt to suppress legitimate height changes when an error, interruption,
  or newly streamed content adds visible information.

## Design

### Stable message geometry

Render the user-message action slot for the full Turn lifecycle. The slot owns
the existing final-state action-row height and gap while its controls remain
absent and non-interactive during a live Turn. Completion fills the existing
slot instead of inserting a new layout row above the response.

Replace the separate live generating sibling and terminal response-actions row
with one stable response footer. The footer remains mounted at one height below
the response region; it shows the generating shape while live and swaps in the
existing Copy, Continue in new chat, and Details controls when terminal. A live
Turn without response text uses the same response shell so its first text delta
does not introduce a second status row.

### Process rhythm

Do not render `.thread-process-timeline` when it has no process Items. Give the
process rule one explicit tokenized distance from the status line, and give the
timeline the same distance below the rule. When there is no timeline, the
existing Turn row gap supplies that same distance between the rule and the
answer. Expanded and live process timelines retain their current content and
disclosure behavior.

### Stable Markdown block

Render every Markdown block through one memoized component. The live tail passes
`streaming` as data instead of changing from a direct `Markdown` element to a
different component type at completion. Stable completed blocks remain memoized,
while the live tail still rerenders for throttled text updates and uses repaired
streaming Markdown.

### Verification

Extend the canonical Thread E2E coverage with a process-free Turn that exposes
the same final answer before and after completion. Pin all of the following:

- the answer body's top coordinate changes by less than one pixel;
- a bottom-following transcript remains bottom-locked without moving the answer;
- the process-title-to-rule and rule-to-answer distances match;
- the final Markdown block keeps the same DOM identity;
- live controls remain absent and terminal controls retain their current labels
  and hover/focus behavior.

Update `docs/spec/agent-thread-rendering.md` with the stable-geometry and divider
rhythm contract. Validate with typecheck, renderer tests, the focused Thread E2E
suite, docs checks, and light/dark screenshots.

## Files

- `src/renderer/agent/components/ThreadView.tsx`
- `src/renderer/agent/components/items/ThreadItemView.tsx`
- `src/renderer/agent/components/ThreadMarkdown.tsx`
- `src/renderer/styles/thread.css`
- `tests/e2e/agent-thread.spec.ts`
- `docs/spec/agent-thread-rendering.md`

## Risks

- Reserving a stable slot can accidentally expose live actions to pointer or
  keyboard input. Live slots contain no controls and remain presentation-only.
- Moving the generating shape into the response footer can change empty-response
  ordering. The footer stays after all currently visible process and response
  content, preserving the existing contract.
- Geometry assertions can become font-sensitive. Tests compare relative movement
  and paired gaps within one rendered page rather than hard-coding glyph metrics.

## Collision Result

No overlap. On 2026-07-30, `gh pr list` reported no open PRs, and the task board
contained no in-flight claim for the Thread renderer, Thread Markdown, or
`thread.css`. The change avoids every infrastructure-ownership file.

## Open Questions

None. The PM approved the stable-layout direction and requested implementation
and a PR on 2026-07-30.
