# Agent Doc-Drift Notice

The model's beliefs about the document come from reads earlier in its context.
After a Thread sits idle, other actors — the user in the UI, other Threads,
Automations — may edit the document; a forked Thread inherits reads that all
predate the fork point. The write path is already defended reactively
(`node_edit` expected revisions), but the pure question-answering path has no
defense at all: the model can answer from stale reads without touching a tool,
so the reactive layer never fires. This plan adds the proactive half: at Turn
admission, the beliefs the model is carrying are checked against the document as
it is now, and the ones that no longer hold are corrected.

Origin: the prime-agent design study (2026-08-08) named the problem and the
delivery rules — report a concrete invalidation list, never claim state you did
not verify, deliver before the next Turn rather than mid-Turn. The mechanism
comes from the coding agents instead. `Edit(old_string → new_string)` carries the
model's belief INTO the operation and has the host check it against current
bytes; staleness detection is not a separate system, it is the same act as
targeting. That is the idea this plan takes: **check beliefs against current
state, do not recompute what happened from a history log.**

## Goal

At Turn admission, when the document no longer matches what this Thread was
shown, the model receives one bounded notice naming the nodes whose content
changed or that were deleted, carrying the current content for the first few, and
the instruction that those edits were deliberate. A fork's first Turn and a
restarted session run the same check against the same rebuilt beliefs.

## Non-goals

- **No mid-Turn watching.** Beliefs are checked once at admission; changes during
  a running Turn stay the concern of expected revisions.
- **No new model tools**, no protocol or codec change, no new persisted field,
  and no change to the reactive expected-revisions layer.
- **No content-addressed `node_edit`.** Making the write path carry beliefs the
  way `Edit` does is the same idea applied to a different surface, and it is
  strictly better than expected revisions — but it changes `src/core/commands.ts`,
  which is coordinated protocol work, and the write path is not bleeding today.
  Its own plan, its own one-pager.
- **No compaction work.** Carrying a cumulative belief set inside compaction
  summaries is a recorded association for the future compaction pass.
- **No scratch-file coverage.** Expired scratch materializations already fail
  loudly and reactively at read time.

## Design

Shape **(a)**: one complete feature in one PR.

### The invariant

A belief is `(nodeId → digest of what the model was shown)`. At admission each
belief is compared against the current projection. That is the whole mechanism,
and what it buys is the absence of everything a history-interval design needs:
there is no window, no boundary anchor, no retention limit, and no "we may have
missed some" wording, because nothing is being reconstructed from a log. The
journal's 500-entry ring, its truncated `affectedNodeIds` samples, and the
question of whether the boundary is the previous Turn's `acceptedAt` or its
`completedAt` all stop being questions rather than being answered.

It also removes a class of false positive for free: an edit that was undone
before this Turn leaves the digest equal to what the model believes, so nothing
is reported. A history walk would report both operations.

### Observation

A belief is recorded wherever a node is **rendered to the model** — `node_read`
output, each result item of `node_search`, and the `userView` evidence payload
admitted with the Turn. `recordNodeAccess` (`capabilities/agentNodeTools.ts:186`)
already proves this seam works and is already called from the search path; belief
capture is a second consumer of the same moment, not a new hook.

That placement is what closes the gap a history-interval design could not:
`node_search` passes a query rather than node ids, so nothing about its arguments
says which nodes the model saw — but its *results* are the rendering, and the
rendering is where beliefs are taken. Whatever the model was shown is covered, by
whichever tool showed it.

### The belief record

Per node: a small digest of the observable content — the node's text, its parent,
and its existence — plus the id. Exact fields are a build decision, but the rule
is that the digest must cover what would make a remembered answer wrong, and
nothing else, so that metadata churn does not manufacture drift.

The set is held in memory per Thread, capped, and evicted oldest-first when the
cap is hit; an evicted belief is simply not checked. It is rebuilt from the
canonical record on restart and on fork, from the persisted tool-output payloads
that were the observation in the first place. A payload that was truncated
rebuilds as id-only and degrades to a "re-read" line rather than a content claim.
A11: the cache is derived, the record is the source.

### Admission

Compare each belief against the current projection (already reachable at
admission through `getDocumentProjection`). Three outcomes per node: unchanged,
changed, or gone. Zero changed and zero gone injects nothing.

This is memory-to-memory over a bounded set, on a path where a whole document
projection is already in hand. Nothing is read from disk and nothing waits on the
mutation queue.

### The notice

It is a **belief update**, not a warning. For the first **five** affected nodes it
carries the current content, so the ordinary case costs no re-read round trip at
all; outliner nodes are small, which is what makes this affordable here where
injecting a whole file diff would not be. Beyond five it degrades to a count and
a re-read instruction. Deleted nodes are named as deleted — the highest-signal
entry in the list.

```
[document drift] 2 nodes you were shown have changed since you saw them:
"Pricing model" (019f…01) is now: "Enterprise ¥4,800/seat, 10% off annual"
"Q3 plan" (019f…02) has been deleted.
These edits were made deliberately by someone else — do not revert them unless
asked. 1 more node you were shown has changed; re-read it before relying on it.
```

Two doctrine lines, both taken from what the coding agents do and neither in the
original draft. **"Do not revert them"** defends against the failure this feature
would otherwise create: a model told that something it read has changed can read
that as an inconsistency to repair, and overwrite the user's deliberate edit.
**"Re-read before relying on it"** covers the tail beyond the carried content.

Node text entering the notice is user- or model-authored content arriving in
trusted context, so it takes the single-line bounded treatment the transcript
header, the index rows, and the Automation previews already use.

### Attribution is garnish

The operation journal is no longer load-bearing. Its one remaining contribution
is *who*: origin, and the causal Thread id, which the episodic index (#519) makes
resolvable — a model can look the Thread up and read its transcript. When the
journal can answer, one clause is added; when it cannot (truncated ring, empty
after a replica that was not reused), the clause is omitted and nothing else
changes. Correctness never depends on it, so none of its limits need to be
described to the model.

### Delivery and A12

Injection uses `additionalContext`, the channel `automation_info` already uses:
admitted as context evidence, projected by `ContextProjector`, no new payload kind
and no protocol change. Two properties follow from that choice — "never
mid-Turn" is true by construction, because admission is when evidence is
admitted; and the notice enters the canonical record, so a transcript reader can
later audit exactly what the model was told.

A12: any failure — projection unavailable, digest comparison throwing, belief
rebuild failing — skips the notice and never blocks admission. The notice claims
only what was actually compared.

### Volume

One line when a single node changed, at most four when several did. A user
editing while they chat is the common case, not the exception, so the cap is
implemented rather than intended.

## Open questions

- Whether the attribution clause labels an Automation separately from another
  interactive Thread. Both are "another session" and both name their Thread id,
  so the label earns its place only if resolving `threadSource` is cheap at
  admission — decide at build, note the call.
- The belief-set cap, and whether eviction is by count or by age. Lean small:
  a Thread that has been shown hundreds of nodes is one whose earliest beliefs
  are least likely to be load-bearing.
