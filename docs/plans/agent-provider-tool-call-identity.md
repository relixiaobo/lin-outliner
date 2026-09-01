# Agent Provider Tool-Call Identity

**Shape:** (a) ONE complete feature in one PR. The internal identity cutover,
provider-history provenance, active-Turn correlation, durable projection,
clean pre-release reset, specifications, and regression coverage ship together.

## Goal

Separate Tenon's canonical tool-execution identity from provider-authored wire
identity so a provider-controlled string never becomes a Thread Item ID,
execution identity, mutation cause, or persistence key. Preserve enough exact
provider history to replay a settled tool exchange through the same adapter and
to reconstruct a collision-safe exchange before a different adapter performs
its target-provider conversion.

After the cutover, a Thread may switch among OpenAI Responses, Anthropic
Messages, and other supported providers after any number of tool calls without
an invalid tool-call ID, a mismatched result, duplicate execution, or lost
history. Restart, fork, compaction, retry, and delegated execution use the same
identity contract.

## Non-goals

- No provider-specific ID regex, truncation rule, or request-body patch in
  Tenon. The Host owns a provider-neutral cross-model correlation ID; final
  wire validation and provider-specific constraints remain owned by `pi-ai`
  adapters.
- No `pi-ai` dependency upgrade in this PR. The identity fix is verified against
  the pinned transport before a separate package upgrade changes auth, catalog,
  or serializer behavior.
- No migration, compatibility decoder, or in-place rewrite for pre-cutover Agent
  data. Reset isolated pre-release userData and delete the old reader shape.
- No change to tool schemas, capability admission, permission policy, execution
  batching, retry budgets, or tool-result semantics.
- No renderer exposure of raw provider tool-call IDs or source transport
  metadata.

## Design

### Canonical identity and provider correlation

The native kernel mints a fresh UUIDv7 `toolCallId` for every provider tool call
before admission, including non-empty and globally unique provider IDs. This is
the only identity used by tool execution, Item recording, pending state,
mutation causation, diagnostics activity correlation, result settlement, and
all persisted Thread relationships.

The provider-authored ID remains opaque input. It is never used as a path
segment, checked for UUID syntax, or promoted to canonical identity. For each
active call, the kernel chooses a separate `activeProviderToolCallId`: preserve
a non-empty batch-unique raw ID, or substitute the portable UUID-derived ID for
an empty or repeated raw ID. The active assistant call and tool result are both
rewritten to this correlation ID before another provider request. Every Host
event and tool handler still uses the internal UUID.

The active batch keeps an ordinal mapping among raw provider input, active
provider correlation, and internal identity; it never looks up a call by the
raw ID. A provider call whose opaque replay fields exceed their admission
budget still executes under its internal UUID and keeps its selected active
representation untruncated; empty or repeated IDs remain healed. Its durable
model-call history becomes `evidenceOnly` rather than storing a truncated value
that could not be replayed exactly.

Kernel batch state carries all three identities explicitly. No shared string
field changes meaning by phase, and no lookup infers one identity from another.

### Durable provider-call envelope

Every `replayable` or `redactedReplay` `ModelToolCallHistory` stores one bounded
provider-call envelope beside canonical tool identity and arguments:

```ts
interface ModelProviderToolCall {
  readonly id: string;
  readonly api: string;
  readonly provider: string;
  readonly model: string;
  readonly thoughtSignature: string | null;
}
```

`id` is the provider-visible identity used to pair the successful active
exchange: either the preserved raw ID or the portable healed ID. The source
fields come from the assistant response that authored the call, not from
current Thread configuration. `thoughtSignature` is the opaque `pi-ai`
tool-call replay field: it is preserved in place for an exact same-model replay
and omitted when absent. It is not interpreted as Gemini-only data.
Evidence-only calls are rendered as bounded evidence and do not retain a replay
envelope.

Admission limits provider call IDs and source-model strings to 4 KiB each and
`thoughtSignature` to 64 KiB, measured as UTF-8 bytes. An over-budget live field
selects executed `evidenceOnly` with reason `providerReplayUnavailable` without
failing tool execution or truncating the active exchange. Once a `replayable`
or `redactedReplay` Item is persisted, the complete envelope is required: the
codec rejects missing, malformed, or over-budget inline envelope data at the
decode boundary. Renderer projection omits the whole envelope. Fork,
persistence, rollout rebuild, and compaction copy it only as part of the
immutable model-call history already owned by the Item.

### Active-Turn correlation

Provider messages and Host execution events have separate projections of the
same admitted call:

- active provider history keeps the selected provider-visible correlation ID
  and pairs the following `toolResult` with it;
- tool admission, execution, cancellation, collaboration, artifacts, and Item
  recording use the internal UUID;
- one explicit ordinal batch mapping links raw, active, and internal identities
  while the provider response is active.

The mapping survives multiple calls in one response, repeated raw IDs, parallel
execution, steering, retry, and cancellation. A provider result can never be
matched by scanning canonical history or by assuming the two IDs are equal.

Active and durable history split by outcome:

- a bounded call with a non-empty batch-unique raw ID uses that ID in active
  history and stores it in the durable replay envelope;
- an empty or repeated raw ID uses the distinct `tc_<uuidhex>` ID for the
  active assistant call and result, and stores that healed provider-visible ID
  in the durable replay envelope;
- an over-budget replay field remains untruncated in transient active history,
  including the result of an executed tool, but persists only bounded executed
  `evidenceOnly` history with reason `providerReplayUnavailable`;
- a call rejected before execution rewrites the active assistant call to
  correction evidence and emits no provider result;
- an executed `evidenceOnly` call retains its transient active assistant call
  and result so the current model observes the outcome, while later durable
  projection emits bounded evidence and never reconstructs a call/result pair.

Thus `evidenceOnly` describes durable replay eligibility, not whether execution
occurred. The admission decision's independent `execute` flag remains the
authority for active result inclusion.

### Durable history and provider switching

`CanonicalContextProjector` reconstructs each replayable tool exchange from the
provider-call envelope. The assistant message uses the recorded source
`api/provider/model`, the call uses the recorded provider-visible ID, and the
paired result uses that same ID. Projection flushes before combining calls from
different source envelopes, so one synthetic assistant message never claims
mixed provenance.

Before handing history to `pi-ai`, the projector compares the recorded
`api/provider/model` tuple with the target model:

- an exact same-model replay restores the stored active provider ID and
  `thoughtSignature` without altering those durable replay fields;
- every other replay replaces both the call ID and its paired result ID with
  `tc_<uuidhex>`, a deterministic one-to-one encoding of the canonical UUIDv7
  `toolCallId`, and removes `thoughtSignature`.

The portable ID uses only ASCII letters, digits, and underscore, is 35
characters long, and cannot collide for distinct admitted internal UUIDs. It is
stable across restart, fork, compaction, retry, and repeated projection. This
prevents lossy adapter normalization from mapping distinct source IDs such as
`abc|def` and `abc/def` to the same target ID. `pi-ai` remains the final
target-provider codec and may enforce stricter provider rules; Tenon neither
copies provider regexes nor post-processes a materialized request body.

The A12 boundary is explicit. Missing, malformed, or over-budget required
inline envelopes fail closed during persisted Thread decode, before projection.
Unavailable or corrupt external argument/result payloads remain runtime
conditions and degrade only that exchange to the existing bounded historical
evidence path rather than killing the Turn.

### Clean cut and specifications

The persisted `modelCall` shape changes atomically with the kernel and
projector. Existing pre-release Agent userData is reset; no optional envelope,
legacy Item-ID fallback, or dual projection path ships. Current specifications
replace the rule that preserves ordinary provider IDs as canonical IDs with the
separated identity contract and record `pi-ai` as transport-only adapter
authority.

## Files

Expected implementation surface after rebasing onto the final shared Agent
protocol baseline:

- `src/core/agent/protocol.ts`
- `src/core/agent/codec.ts`
- `src/core/agent/modelCallHistory.ts`
- `src/main/agent/runtime/kernel/kernel.ts`
- `src/main/agent/runtime/kernel/types.ts`
- `src/main/agent/runtime/kernel/NativeAgentRuntime.ts`
- `src/main/agent/runtime/toolCallHistory.ts`
- `src/main/agent/runtime/PiTurnExecutor.ts`
- `src/main/agent/context/ContextProjector.ts`
- `src/main/agent/context/TurnDiagnostics.ts`
- focused Core fixtures and tests for codec, kernel, projection, persistence,
  diagnostics, fork, compaction, and Thread execution
- `docs/spec/agent-core.md`
- `docs/spec/agent-model-runtime.md`
- `docs/spec/agent-tool-design.md`
- `docs/spec/agent-integration.md`

The implementation queue is derived from `ModelToolCallHistory`,
`providerToolCallId`, tool-admission events, and historical tool-call projection
search hits after the predecessor rebase; the list above is an ownership
forecast, not a hand-maintained completion ledger.

## Risks

- OpenAI Responses carries compound call/item identities. Losing the exact
  provider-visible active history can break the next request even when call and
  result appear paired; serializer-level tests must inspect the real request.
- Separating IDs can accidentally pass the provider ID to a tool handler or the
  internal UUID to a provider result. Tests must assert both sides in the same
  multi-call execution.
- Simple replacement and truncation can collide. Provider-history healing must
  derive cross-model IDs one-to-one from canonical UUIDs and must not rely on a
  provider-specific character allowlist.
- Incorrect source metadata recreates the current failure by causing `pi-ai` to
  treat cross-provider history as same-model history.
- Opaque provider replay fields are untrusted and may be very large. Admission
  must select `evidenceOnly` before persistence without turning an inspection
  concern into a dead Turn or dropping the transient result; persisted envelope
  corruption must still fail closed at decode.
- A future adapter may impose constraints outside the conservative portable ID
  alphabet. Serializer coverage must gate each newly supported adapter rather
  than weakening the Host's collision guarantee.
- The protocol, projector, and runtime files are high-collision ownership
  surfaces. Re-run the open-claim check immediately before implementation and
  stop on any new shared-interface overlap.

## Verification

- Codec tests reject missing, malformed, and oversized provider-call envelopes
  while admission tests prove oversized live replay fields become
  executed `evidenceOnly` without blocking execution or removing the transient
  result, and renderer projection proves the envelope stays Host-private.
- Kernel tests prove every provider call receives a distinct UUIDv7 internal ID
  while valid provider IDs remain exact and empty or repeated IDs receive
  distinct paired portable IDs in live assistant calls and results. Executed
  and rejected `evidenceOnly` cases assert opposite transient-result behavior,
  including parallel batches, retry, cancellation, and steering.
- Same-model serializer tests inspect empty and repeated raw-ID cases and prove
  the materialized assistant calls and results use distinct paired portable
  IDs rather than the ambiguous source values.
- Real `pi-ai` serializer tests inspect OpenAI Responses -> Anthropic Messages
  and Anthropic Messages -> OpenAI Responses request bodies, including IDs with
  `|`, IDs longer than Anthropic's limit, and normalized-ID collision cases.
  The request body must contain distinct `tc_<uuidhex>` call/result pairs.
- Context projection tests preserve recorded source metadata and exact pairing
  across restart, fork, compaction, redacted replay, unavailable payloads, and
  mixed-provider Thread history.
- Google serializer tests preserve a tool call's `thoughtSignature` in place
  across same-model restart, fork, and compaction, and omit it after any target
  model change.
- Thread-service tests prove historical calls are never re-executed and new
  tools execute exactly once after a provider switch.
- Run `bun run typecheck`, `bun run test:core`, `bun run test:renderer`,
  `bun run docs:check`, and focused `bun run test:e2e` coverage before ready.

## Open questions

None. The Host owns internal UUID identity, exact bounded same-model replay, and
portable collision-safe cross-model correlation. Provider-specific wire
validation remains an adapter responsibility. A `pi-ai` upgrade and any
upstream collision-normalization improvement are separate dependency work; this
fix does not depend on an unreleased transport change.

## Implementation checklist

- [ ] Regenerate the implementation queue from current search hits on the
      merged shared Agent protocol baseline.
- [ ] Cut the persisted model-call envelope and codec in one change.
- [ ] Separate active provider correlation from Host execution identity.
- [ ] Rebuild same-model history exactly and cross-model history with paired
      portable IDs.
- [ ] Reset isolated pre-release Agent userData and verify clean startup.
- [ ] Add provider-switch, lifecycle, serializer, and non-reexecution coverage.
- [ ] Fold the design into current specifications and archive this plan at the
      integration gate.
