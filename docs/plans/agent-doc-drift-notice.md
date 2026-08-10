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
- **The boundary is the previous Turn's `acceptedAt`, not its `completedAt`.**
  A foreign edit landing WHILE the previous Turn ran, after the model's last
  read, is exactly the "confident stale answer" this plan exists to kill — and
  `completedAt` would never report it, because the next comparison starts after
  it. `acceptedAt` costs the opposite error, re-reporting an edit the model may
  already have seen mid-Turn, which is one round of unnecessary caution. The
  asymmetry is decisive. The Thread's own edits are filtered by causation either
  way, so the wider window does not make the Thread suspicious of itself.
- **Fork and rollback need no special case.** Anchoring on the previous Turn
  makes both fall out: a fork's inherited history ends at the fork point, so its
  first Turn compares against that Turn, and a rollback's new boundary is
  whatever Turn survived it.
- **Touched-node set spans reads AND writes.** Writes alone are not enough — the
  path being defended is question-answering, so what matters most is what the
  model READ, and reads never enter the journal. Three structured sources, none
  of them text parsing: node tool call arguments (our own tools, with a catalog
  snapshot guard, so the field shapes cannot drift silently), the `userView`
  evidence payload admitted with each Turn, and journal causation for the write
  set. Known gap: nodes reached through `node_search`, whose arguments carry a
  query rather than ids. It is left uncovered rather than recovered by parsing
  result text — the total count line always fires, so a missed intersection
  costs a routing hint, never silence.
- **Maintenance is incremental, derivation is canonical.** Walking the whole
  history at every admission gets linearly more expensive as a Thread grows, so
  the set is cached in memory and extended at the Turn-completion seam (the same
  one the transcript writer uses), and rebuilt from the canonical record on
  restart and on fork. A11: the cache is derived, the record is the source.
- **The journal is a bounded 500-entry ring**, serialized with the local replica
  and restored at startup. Two honest degradations follow. When its oldest entry
  is newer than the boundary the window is incomplete, and the notice says "at
  least N" rather than claiming a total it cannot know; the same wording covers
  `affectedNodeIdsTruncated`. When the journal is empty — a replica that was not
  reused — nothing is injected at all, because claiming no drift and claiming
  unseen drift are both claims the record does not support.
- **Injection uses `additionalContext`**, the channel `automation_info` already
  uses: admitted as context evidence, projected by `ContextProjector`, no new
  payload kind and no `protocol.ts`/`codec.ts` change. Two properties fall out of
  that choice — "next-turn prefix, never mid-Turn" is guaranteed by construction
  because admission is when evidence is admitted, and the notice enters the
  canonical record, so a transcript reader can later see exactly what the model
  was told. The journal read must be the non-queued one: `operationHistory` waits
  on the mutation queue's text-edit group, and admission must not; an operation
  landing a moment later is next Turn's news.
- **Message.** One bounded notice: elapsed time since the previous Turn, foreign
  edit counts split into the user's own UI edits and other sessions' (naming the
  causal Thread id, which the episodic index makes resolvable), up to **five**
  intersecting node references with their current titles, and one doctrine line —
  re-read before relying on remembered content; existing node references may be
  stale. A node deleted since the boundary is marked as such: it is the highest
  signal in the list. Titles are user- or model-authored text entering trusted
  context, so they take the single-line bounded treatment the transcript header
  and index rows already use.
- **Volume discipline is part of the contract.** A user editing while they chat
  is the common case, not the exception, so the notice is one line when nothing
  intersects and at most four when something does. The cap is implemented, not
  merely intended.
- **A12.** Journal query or set-derivation failure skips the notice and never
  blocks Turn admission; the notice claims only what was actually computed.

## Open questions

- Whether the origin split labels an Automation's edits separately from another
  interactive Thread's. Both are "another session" and both name their Thread
  id, so the label is worth its cost only if resolving `threadSource` for the
  causal Threads is cheap at admission — decide at build, note the call.

The other two are settled above: the intersection cap is five, and the
touched-node set comes from tool call arguments plus the `userView` payload plus
journal causation, because a causation-only set would miss reads and reads are
the whole point.
