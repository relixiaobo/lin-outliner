# Agent Trajectory Evidence Fidelity

**Shape:** (b) A SET of two complete features. First ship truthful live paging,
and bounded inspection work as one independently measurable PR. Then ship
exact-or-unavailable capture/projection and retire the unreachable legacy export
as one complete PR on that foundation; lossy paths are deleted only after the
exact path is covered.

## Goal

Trajectory is the forensic view of an Agent execution. A technical user must be
able to inspect what the model actually saw, what it returned, what a tool
consumed, and what model-visible result the tool produced. Evidence is either
the exact retained value from its named runtime boundary or explicitly
unavailable. It is never a redacted, truncated, or inferred approximation.

The minimum outcome is that the reported 8,087-character System Reminder
appears byte-for-byte in Context Preview, Raw, copy, restart, and fork after more
than 64,000 earlier characters. The same rule applies to provider
requests/responses and Tool evidence.

## Non-goals

- No packet trace: authentication headers, environment variables, Keychain
  data, arbitrary response headers, and values that never entered model or
  tool execution stay outside Trajectory.
- No change to provider bytes, context budgeting, tool admission/execution,
  settlement, or prompt-cache behavior.
- No change to canonical `redactedReplay` / `evidenceOnly` policy. Operational
  replay history may stay redacted; Trajectory independently records the exact
  original execution boundary.
- No change to `errors.jsonl` or its Settings export. Runtime-error reporting is
  not Agent execution evidence.
- No duplicate binary bytes in diagnostics or IPC. Existing audited
  content-addressed resources remain the byte authority.
- No migration for already-lossy history, encryption, reveal mode, alternate
  sanitized view, warning flow, or setting. Pre-release development data resets.

## Design

### Requirements and evidence authority

- **FR-1:** Detail preserves the complete retained value from each named
  boundary: prepared provider context after projection/budgeting/compaction;
  post-adapter JSON immediately before transport; provider-neutral terminal
  response; exact model-issued Tool arguments; and complete persisted
  model-visible Tool output.
- **FR-2:** Ledger summaries may normalize whitespace and ellipsize because they
  only locate records. Preview, Request, Input, Output, Schema, Raw, and copy are
  evidence surfaces and inherit no summary bound.
- **FR-3:** Missing, corrupt, invalid, or oversized diagnostics make the affected
  evidence unavailable. No fallback may substitute an Item summary, Host
  presentation field, redacted value, prefix, empty object, or fabricated zero.
- **FR-4:** A binary digest/reference is exact only while its bytes remain
  reachable through the existing audited reader. Otherwise the evidence is
  unavailable, not a complete image preview.
- **FR-5:** Copy returns the exact text or one pretty-printed serialization of
  the exact structured value shown.
- **FR-6:** Live pagination reflects the records that are actually loaded.
  A cursorless notification refresh that joins the loaded window to the current
  tail retires any stale `newerCursor`; `Load newer` remains only when an
  unloaded gap still exists between the historical window and the loaded tail.
- **FR-7:** Work scales with the visible record window, not total Thread history
  or retained evidence bytes. Opening, paging, and live refresh never rebuild
  or resend exact detail that the user did not select.

`Completed` remains an execution state, separate from evidence availability.
Retire `partialCoverage`: the value is exact or that evidence is unavailable.

### Capture without rewriting

`TurnDiagnosticsCollector` stores its `jsonValue` representations directly.
Remove diagnostic Secretlint from canonical prepared messages, post-adapter
requests, and Assistant responses. Remove the shared 64,000-character scan
budget, diagnostic omission markers, scanner-failure replacement, and
configured-base-URL stripping. The exact configured endpoint is evidence; no
transport authentication header is newly captured.

Intentional execution transforms remain visible as such. Provider-neutral
normalization is the Agent-kernel response authority. Tool Output is the full
stable text delivered to model history, not reconstructed Host-private fields.
Image/base64 bytes may remain outside diagnostics only when an existing retained
resource owns those exact bytes and Trajectory can resolve that identity.

Keep the immutable, content-addressed, Thread-owned diagnostics store and its
16 MiB all-or-nothing admission boundary. An oversized payload becomes
unavailable; it never triggers field truncation. A generated fixture for the
largest supported text context must prove one valid model call fits. If it does
not, deduplicate the existing digest pools in this PR rather than raising an
unguarded limit or introducing another lossy representation.

Delete `redactSecretLikeJsonForDiagnostics` and its budget branch from
`agentSecretRedaction.ts`; keep only complete durable redaction. Custom Responses
stream-noise remains a bounded, secret-scanned error snippet because a dropped
relay frame is transport telemetry, not model/tool execution evidence. Give it
a narrow local helper and continue to label it as a snippet.

### Project exact evidence

Delete these `ThreadTrajectoryProjection` mutations:

- credential-like JSON key filtering and recursive text/encoded-JSON redaction;
- the 20,000-character leaf, 40,000-byte evidence, 64,000-byte response,
  100-entry collection, and JSON depth/key/array limits and loss markers;
- typed-detail fallbacks that discard variable evidence; and
- replacement of an oversized Tool call ID inside displayed/copied evidence.

Opaque record keys may still hash an anomalous Tool call ID, but detail and copy
retain its exact value. The projector selects or clones typed evidence; it does
not sanitize it. Ownership checks, one-record lazy reads, digest verification,
and local unavailable states remain.

Tool Input resolves the exact model-issued call from its source provider
response by original call ID. A canonical `replayable` call is an exact fallback
only when diagnostics are unavailable; `redactedReplay` and `evidenceOnly` are
never promoted to exact input. Tool Output reads the full `outputRef`. Context
and Input Preview read captured prepared parts. Assistant Preview and Request
read the captured response and materialized post-adapter request. No tab borrows
a neighboring authority.

### Bound work without losing evidence

Keep paging record-based end to end. `buildWindow` must stop treating the
120-record request limit as permission to load 120 complete Turns. Starting at
the tail, cursor, or focus Turn, it reads Turns in adaptive batches only until
the requested record page is covered, plus the one predecessor needed for
stable-prompt/tool-catalog state. Whole-Thread summary facts use lightweight
Turn metadata and do not deserialize every Turn's Items or diagnostics.

Cache only the bounded projected summary for an immutable completed Turn, keyed
by its canonical Turn identity and diagnostics digest. The cache is rebuildable,
bounded, and contains no substitute evidence; detail still performs its one
authoritative lazy read. The active Turn remains uncached or revision-keyed so
streaming state cannot become stale.

Notification refresh is single-flight and coalescing: while one cursorless read
is active, later relevant notifications request at most one follow-up read. A
superseded response may be ignored, but obsolete reads are not allowed to pile
up in main. Completed cached Turns are not reread or reprojected for every
streaming delta in the active Turn.

Renderer owns one contiguous working window capped at three 120-record pages,
plus structural ancestors required by those covered records. A selected page
takes priority over automatic tail following at the cap. When a live tail join
fits without evicting that page, `followingTail` joins it, evicts an unpinned
oldest edge if necessary, and clears `newerCursor` only after the tail is actually
covered. If the join would evict the selected page, renderer switches
`followingTail` to false, applies authoritative replacements inside retained
coverage, defers the new suffix, and keeps a truthful `newerCursor`. The same
defer rule applies when the user already scrolled into history.

`Load newer` is the explicit navigation back toward that deferred tail. If this
action crosses the cap and would evict the selected page, it closes the inspector
before eviction. No disjoint pinned page or detached detail state is introduced.

Ledger virtualization stays fixed-row. Timeline renders only the same bounded
window; it never creates one DOM control per record in total Thread history.
Every record remains reachable through the two stable cursors without retaining
an ever-growing renderer array.

### Renderer and cleanup

Retire `thread/trajectory/export` end to end. It has no renderer caller and the
current spec explicitly excludes it from the Trajectory UI; preserving or
redesigning an unreachable second evidence path is dead pre-release machinery,
not a user capability. Delete the protocol method, codec branches, projection
bundle builder, service/desktop writer, mocks, tests, messages, and current-spec
contract. Do not add a replacement export control.

Renderer keeps lazy mounting, exact copy, wrapping, pretty-printing,
unavailable/corrupt states, and audited image reads; remove only the now-dead
`partialCoverage` handling and copy.

Production scope:

- `TurnDiagnostics.ts`: direct exact capture and exact configured URL.
- `ThreadTrajectoryProjection.ts`: exact selection; delete sanitizers, budgets,
  collection caps, evidence fallbacks, and the export bundle; make record-window
  reads adaptive and cache bounded completed-Turn summaries.
- `ThreadCore.ts` and `ThreadHistoryProjectionStore.ts`: provide the lightweight
  Turn metadata/paging reads used by Trajectory summary and window discovery.
- `ThreadService.ts` and `desktopHost.ts`: delete the unreachable export service
  and writer.
- `agentSecretRedaction.ts` and `sseResilientFetch.ts`: delete the generic
  diagnostic API; isolate the transport-noise snippet scrub.
- `protocol.ts`, `codec.ts`, and English/Simplified Chinese Agent messages:
  retire `partialCoverage` and `thread/trajectory/export`. This shared interface
  is one isolated claim.
- `ThreadTrajectoryPanel.tsx`: replace action-history-based cursor updates with
  one coverage reconciliation path for initial, older, newer, and cursorless
  live reads; coalesce refreshes and bound the contiguous renderer window.
  Scroll following remains an independent user-position fact and does not keep
  an obsolete pagination control alive.
- `TrajectoryLedger.tsx`, `TrajectoryTimeline.tsx`, and `trajectoryModel.ts`:
  consume only the bounded working window and preserve fixed-row virtualization.
- `agent-core.md`, `agent-model-runtime.md`, and `agent-thread-rendering.md`:
  replace sanitized/bounded evidence with exact-or-unavailable semantics.
  `error-observability.md` stays unchanged.

Focused tests are `agentSecretRedaction.test.ts`,
`agentTurnDiagnostics.test.ts`, `agentTrajectoryProjection.test.ts`,
`agentCodexProtocol.test.ts`, `threadTrajectoryPanel.test.tsx`, and the existing
Trajectory Electron E2E. Regenerate the final edit queue from `rg` hits; done
means no retired live symbol or marker outside historical archive/changelog text.

### Risks and accepted tradeoffs

- **TRD-1:** Trajectory `userData` may contain credentials that entered
  execution. This PM-selected tradeoff protects forensic fidelity through local
  ownership, not mutation.
- **TRD-2:** A selected detail can be large. Keep reads lazy and record-scoped;
  measure the maximum fixture and the reported long Turn without reintroducing
  a content budget.
- **TRD-3:** Existing loss markers cannot be reconstructed. Reset development
  data; do not guess or add a compatibility reader.
- **TRD-4:** Later replay may contain a durable redacted call. Show that later
  model-visible representation at its own call while preserving the exact
  original response at the original call.
- **TRD-5:** A cold page can still read one large Turn because record identity
  lives in that Turn's diagnostics. Accept one authoritative Turn read; do not
  hide it with lossy metadata. Adaptive paging, bounded summary caching, and
  single-flight refresh prevent that cost from multiplying across 120 Turns or
  concurrent refreshes.

## Verification

- The 64,000-plus-8,087 fixture is exact in Context Preview, Raw, copy, fork,
  and restart, with no omission marker.
- Sentinel credentials survive prepared context, request, response, configured
  URL, Tool Input, Tool Output, and detail. A separate regression proves
  canonical replay redaction and error-log policy are unchanged.
- Strings over 20,000 characters, collections over 100 entries, deep valid JSON,
  and a large call ID remain exact; only the opaque record key may hash the ID.
- Missing/corrupt/oversized diagnostics are unavailable, never partial. The
  largest supported text context fits the admission limit or drives same-PR
  digest-pool deduplication.
- A focused historical page may initially expose `Load newer`. When a new Turn
  triggers a cursorless refresh, a following window joins the tail and removes
  `Load newer`; a non-following window accepts in-range replacements but defers
  any suffix that would evict the inspected page and keeps one working control.
- Instrumented 10,000-Turn and 100,000-record fixtures prove that an ordinary
  tail read/refresh materializes only enough Turns for 120 covered records plus
  one predecessor, keeps at most one read active plus one coalesced follow-up,
  retains at most three pages plus structural ancestors in renderer, and never
  reads detail evidence for an unselected record. Prefer operation/read/DOM
  counts over flaky wall-clock assertions; record a real-run latency and memory
  baseline before accepting any cache or window tradeoff.
- A many-page paging test traverses beyond the renderer cap in both directions,
  proving evicted records remain reachable, cursors have no gaps or duplicates,
  following refresh joins the tail when it fits, a cap-crossing refresh yields
  follow to the selected page and keeps a real `newerCursor`, and explicit
  bound-crossing navigation closes the inspector before eviction.
- Protocol, codec, service, desktop-host, mock, test, message, and current-spec
  sweeps find no remaining `thread/trajectory/export` route.
- Stream-noise tests keep its bounded scrub isolated from execution evidence.
- Run `bun run typecheck`, `bun run test:core`, `bun run test:renderer`, focused
  Trajectory E2E, `bun run docs:check`, and `git diff --check`.
- Manually verify the reported research Thread in light/dark mode across
  Context, Request, Assistant, Tool, Raw, copy, restart, and fork.

## Acceptance Criteria

- **AC-1:** Every retained model/tool execution value is exact across detail,
  Raw, copy, restart, and fork.
- **AC-2:** No Trajectory capture/projection invokes Secretlint, filters keys,
  or emits redaction, truncation, or diagnostic-budget markers.
- **AC-3:** Bounded summaries never become evidence; unavailable evidence is
  explicit and local to its surface.
- **AC-4:** Capture remains observational and does not change execution, replay
  policy, or error-log policy.
- **AC-5:** `rg` finds no live diagnostic omission constants/helper, detail
  evidence budgets/fallback, or `partialCoverage` state.
- **AC-6:** New Turn notifications never leave a stale `Load newer` control
  after the current tail is loaded, while genuine unloaded gaps remain
  reachable through stable pagination.
- **AC-7:** Ordinary Trajectory reads and refreshes have bounded diagnostics
  reads, projection work, in-flight requests, renderer records, and timeline /
  ledger DOM independent of total Thread history; the unreachable legacy export
  route no longer exists.

## Collision Result

The board has no active Trajectory claim. PR #622 is merged and this plan is
rebased onto it. This design-only PR touches no file claimed by open PRs. For
implementation, PR #623 claims `ThreadService.ts` plus core protocol/codec for
Generic Background Tool Tasks. The paging/performance unit has no overlap and
can ship independently; the exact-evidence/legacy-export-removal unit overlaps
`ThreadService.ts` and protocol/codec. Land those edits behind #623 or coordinate
a separate interface-only claim after it rebases; do not develop both shared
surfaces in parallel. The remaining Trajectory projection, renderer,
diagnostics, and spec files do not overlap #620, #621, or #623 at this check.

## Open questions

None. Exact-or-unavailable evidence, raw local values, no sanitized mode, no
replacement export UI, and no migration are PM-ratified product decisions.

## Implementation checklist

Paging/performance unit:

- [ ] Reconcile live tail coverage and delete stale action-based cursor state.
- [ ] Make record paging adaptive, cache bounded immutable summaries, coalesce
      notification reads, and cap the renderer working window.
- [ ] Update the rendering/core specs and run paging, scale, renderer,
      E2E, type, docs, and whitespace verification.

Exact-evidence unit:

- [ ] Regenerate the edit queue from retired symbols on the merged #622 base.
- [ ] Capture exact boundary values and prove the diagnostics admission ceiling.
- [ ] Make detail and copy exact; retain only bounded summaries and audited
      binary references.
- [ ] Delete diagnostic redaction/budgets and retire `partialCoverage`.
- [ ] Delete `thread/trajectory/export` across protocol, main, tests, messages,
      mocks, and current specs.
- [ ] Update specs and replace redaction tests with fidelity, unavailability,
      and non-interference coverage.
- [ ] Run automated, long-Turn, fork/restart, manual, and empty-`rg`
      verification.
