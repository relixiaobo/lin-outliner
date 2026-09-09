# Performance Optimization Candidates

**Shape:** (b) A SET of three independent complete optimizations. Each unit has
its own measurement and, when justified, implementation and verification PR.

## Goal

Evaluate the candidate costs that remain after incremental projection, sparse
transactions, virtualized rendering, typing-path repair, renderer indexes, and
Runtime cutover shipped. This plan is no longer the historical P0-P3 program;
it contains only work whose current symbols still exist and that is not owned by
the shipped interaction-jank work or another active plan. Symbol existence and
repeated scans are evidence of possible cost, not proof of a meaningful current
performance problem. No candidate starts as a pre-approved data-structure rewrite.

## Non-goals

- No reimplementation of shipped projection, reverse-edge, date-navigation,
  formatting, search-complexity, or typing-path work.
- No optimization justified only by asymptotic shape. Measure the current path
  before changing data structures or immutability boundaries (A9).
- No search-scope reduction, language-support reduction, or other product
  behavior trade disguised as performance work.
- No reimplementation of Runtime selector indexes or translation geometry
  delivered by the interaction-jank changes.
- Window-first startup follows the current
  [Desktop Host lifecycle](../spec/architecture.md#desktop-host-lifecycle).
  First paint precedes Runtime readiness; verified snapshot loading and
  transaction-log replay still gate document requests. A first-paint improvement
  is not a claim that those services initialize faster.

## Design

### Requirements

- **FR-1:** A unit ships only when a repeatable current-main probe shows a
  meaningful user-path or resource improvement.
- **FR-2:** Derived indexes and caches rebuild from canonical state and cannot
  become write, ordering, or correctness authorities.
- **FR-3:** Every unit preserves result scope, ordering, Unicode behavior, and
  failure semantics byte-for-byte unless a separate product decision says
  otherwise.

Before changing a candidate, record the current commit, fixed fixture, selected
user operation, cold/warm conditions, latency distribution, relevant process or
allocation count, and an improvement threshold justified by that operation.
Measure under comparable load and keep correctness assertions identical. If the
observed cost or improvement is immaterial, close that candidate with the probe
result; do not replace it with a different optimization under the same claim.
Measurement is the first internal step of each complete unit, not a new required
infrastructure PR. The board records eligibility and the resulting decision.

### Unit 1: Core mutation indexes

Measure deletion, backlink lookup, schema-name lookup, and repeated state reads
on a large field/tag/reference-heavy document. If the current probes confirm
material cost, add transaction-maintained indexes so:

- `collectSubtreeAndDependentReferences` and
  `hasExternalReferencesToTarget` visit the removed closure and real referrers,
  not the whole document repeatedly;
- `backlinks` reuses the same canonical reference facts;
- `findTagByName`, `findFieldDefByName`, `findNodesWithTagInExtendsChain`, and
  `nextTagColor` reuse schema indexes; and
- one command hoists a stable `snapshot()`/materialized view rather than
  repeatedly requesting equivalent state.

The indexes are derived, rebuilt from canonical state, and updated from sparse
transaction facts. They are never a second authority. The Source cutover is
already represented by the current Core command/state contract. Recheck live
Core claims, particularly tagged extraction, rather than waiting on an archived
plan. `collectSubtreeAndDependentReferences` and the schema scans in `core.ts`
remain candidate locations; that inspection alone does not establish latency.

### Unit 2: Local filename fallback reuse

`rgFileNameMatches` in `nativeLocalFileHost` remains a Spotlight fallback and may
scan the home directory repeatedly. Preserve the existing result scope and
ranking while adding a bounded query/result cache, in-flight request coalescing,
cancellation, and a short invalidation horizon. Do not narrow roots or silently
omit hidden files in
the name of speed. Measure first-launch and repeated-query latency plus spawned
process counts.

### Unit 3: Text-analysis normalization

Remove repeated `normalizeSearchText` work only where callers can prove they
already hold the exact canonical normalized form. Keep a type or private API
boundary that prevents arbitrary strings from claiming normalization. Verify
all Unicode, locale-fold, offset, CJK, and query-equivalence fixtures before and
after; this unit must remain byte-for-byte behavior compatible.

### Deferred measurements

The Shiki language registry already contains lazy import thunks, and one search
result reorder scans only a single explicit result node. Neither is an active
implementation unit without a new profile showing user-visible cost. A future
measurement may create a new complete plan; this one does not preserve old audit
rows as obligations.

### Verification

Each unit records a before/after probe on a fixed fixture, keeps correctness
tests unchanged where possible, adds index rebuild/invalidation tests where
needed, and runs the repository-required gates. A result that does not produce a
meaningful improvement closes the candidate with evidence rather than shipping
complexity.

## Acceptance Criteria

- **AC-1:** The Core unit visits only affected deletion/reference/schema facts on
  the measured fixture and proves rebuild plus transaction-delta equivalence.
- **AC-2:** Repeated filename fallback queries coalesce/cache boundedly while a
  cold or expired query returns the same ordered scope as today.
- **AC-3:** Text normalization produces identical Unicode tokens, offsets, and
  query matches before and after the optimization.
- **AC-4:** A candidate that misses its recorded improvement threshold closes
  with evidence and adds no complexity to product code.

## Open questions

None. Exact cache sizes, invalidation intervals, and index representations are
reversible implementation values selected from the measurement while preserving
the observable contracts above.

## Implementation checklist

- [ ] Regenerate each unit's queue from current symbols and a failing/expensive
      probe, not the historical catalog.
- [ ] Record a current baseline and operation-specific acceptance threshold,
      then refresh shared Core/file-search claims before implementation.
- [ ] Ship each measured optimization independently with before/after evidence.
- [ ] Fold any changed performance invariant into the owning current spec.
- [ ] Run typecheck, relevant tests, docs check, diff check, and the unit's
      repeatable probe.
