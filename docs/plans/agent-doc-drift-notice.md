# Agent Doc-Drift Notice

The model's beliefs about the document come from reads earlier in its context.
After a Thread sits idle, other actors — the user in the UI, other Threads,
Automations — may edit the document; a forked Thread inherits reads that all
predate the fork point. The write path is already defended reactively
(`node_edit` expected revisions), but the pure question-answering path has no
defense at all: the model can answer from stale reads without touching a tool,
so the reactive layer never fires. This plan adds the proactive half: a bounded
drift notice at Turn admission.

Origin: the prime-agent design study (2026-08-08). Prime-agent's
`<ipython_state_restored>` notice lists both the revived variable names and the
ones that failed to revive; its rules — report a concrete invalidation list,
never claim state you did not verify, deliver before the next turn rather than
mid-turn — carry over. Our event-sourced document journal lets us do better
than name lists: we can report exactly which foreign edits intersect the nodes
this Thread previously touched.

## Goal

At Turn admission, when the document has received foreign-origin operations
since this Thread's previous Turn, the model receives one bounded notice:
elapsed time, foreign-edit counts split by origin, the bounded intersection
with nodes this Thread previously read or wrote, and the instruction to
re-read before relying on remembered content. A fork's first Turn always runs
the same computation against its inherited history.

## Non-goals

- **No mid-Turn watching.** Drift is computed once at admission; changes during
  a running Turn stay the concern of expected revisions.
- **No new model tools** and no change to the reactive expected-revisions
  layer.
- **No compaction work.** Carrying a cumulative touched-node list inside
  compaction summaries (prime-agent's read-files/modified-files pattern) is a
  recorded association for the future compaction pass, not part of this plan.
- **No scratch-file coverage.** Expired scratch materializations already fail
  loudly and reactively at read time; that is sufficient.

## Design

Shape **(a)**: one complete feature in one PR.

- **Trigger.** On Turn admission, compare the document journal against the
  Thread's last-Turn boundary. Any foreign-origin operation (user UI, another
  Thread, an Automation — i.e. causation absent or belonging to a different
  Thread) since that boundary triggers the notice. No time threshold: the
  rule stays pure and testable, and the signal-to-noise control is the
  intersection list, which degrades to a one-line count when the changes do
  not touch this Thread's nodes. Zero foreign operations injects nothing.
- **Fork.** A forked Thread's first Turn always computes drift from the fork
  point, using the inherited history's touched-node set.
- **Touched-node set.** Derived from the Thread's canonical record (tool Items
  and document-operation causation), not from a live cache, so restart and
  fork rebuild it for free.
- **Message.** One bounded notice as a next-turn prefix (custom context
  message, not a user message): elapsed time since the previous Turn, foreign
  edit counts by origin, up to N intersecting node references, and one
  doctrine line — re-read before relying on remembered content; existing node
  references may be stale. Never injected mid-turn.
- **A12.** Journal query or set-derivation failure skips the notice and never
  blocks Turn admission; the notice claims only what was actually computed.

## Open questions

- Cap N for the intersection list (lean small; the list is a routing hint, not
  a diff).
- Whether the origin split distinguishes Automation edits from other-Thread
  edits or folds them together.
- Exact derivation source for the touched-node set (tool Items vs the document
  operation journal's causation index) — decide at build against what the
  canonical record already indexes.
