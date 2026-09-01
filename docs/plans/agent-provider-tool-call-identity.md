# Agent Provider Tool-Call Identity

**Shape:** (a) ONE complete feature in one PR. The internal identity cutover,
provider-history provenance, active-Turn correlation, durable projection,
clean pre-release reset, specifications, and regression coverage ship together.

## Goal

Separate Tenon's canonical tool-execution identity from provider-authored wire
identity so a provider-controlled string never becomes a Thread Item ID,
execution identity, mutation cause, or persistence key. Preserve enough exact
provider history to replay a settled tool exchange through the same adapter and
to let a different adapter perform its normal cross-provider conversion.

After the cutover, a Thread may switch among OpenAI Responses, Anthropic
Messages, and other supported providers after any number of tool calls without
an invalid tool-call ID, a mismatched result, duplicate execution, or lost
history. Restart, fork, compaction, retry, and delegated execution use the same
identity contract.

## Non-goals

- No provider-specific ID regex, truncation rule, or request-body patch in
  Tenon. Provider wire constraints remain owned by `pi-ai` adapters.
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

### Two identities, one owner each

The native kernel mints a fresh UUIDv7 `toolCallId` for every provider tool call
before admission, including non-empty and globally unique provider IDs. This is
the only identity used by tool execution, Item recording, pending state,
mutation causation, diagnostics activity correlation, result settlement, and
all persisted Thread relationships.

The provider-authored ID remains an opaque bounded `providerToolCallId`. It is
never interpreted, used as a path segment, checked for UUID syntax, or promoted
to canonical identity. The active provider exchange pairs its assistant call
and tool result with this wire identity while every Host event and tool handler
uses the internal UUID. Empty, duplicate, or over-budget provider IDs receive a
bounded provider-history replacement without changing the internal identity or
aborting the user's Turn.

Kernel batch state carries both identities explicitly. No shared string field
changes meaning by phase, and no lookup infers one identity from the other.

### Durable provider-call envelope

Every `replayable` or `redactedReplay` `ModelToolCallHistory` stores one bounded
provider-call envelope beside canonical tool identity and arguments:

```ts
interface ModelProviderToolCall {
  readonly id: string;
  readonly api: string;
  readonly provider: string;
  readonly model: string;
}
```

`id` is the exact provider-visible identity used to pair the successful active
exchange after empty, collision, and size healing. The source fields come from
the assistant response that authored the call, not from current Thread
configuration. Evidence-only calls are rendered as bounded evidence and do not
retain a replay envelope.

The codec bounds every untrusted string and requires the envelope at the write
boundary. Renderer projection omits the whole envelope. Fork, persistence,
rollout rebuild, and compaction copy it only as part of the immutable model-call
history already owned by the Item.

### Active-Turn correlation

Provider messages and Host execution events have separate projections of the
same admitted call:

- provider history keeps the provider-visible call ID and pairs the following
  `toolResult` with it;
- tool admission, execution, cancellation, collaboration, artifacts, and Item
  recording use the internal UUID;
- one explicit batch mapping links them while the provider response is active;
- rejected/evidence-only calls contribute correction evidence without a
  provider result, preserving current behavior.

The mapping survives multiple calls in one response, repeated raw IDs, parallel
execution, steering, retry, and cancellation. A provider result can never be
matched by scanning canonical history or by assuming the two IDs are equal.

### Durable history and provider switching

`CanonicalContextProjector` reconstructs each replayable tool exchange from the
provider-call envelope. The assistant message uses the recorded source
`api/provider/model`, the call uses the recorded provider-visible ID, and the
paired result uses that same ID. Projection flushes before combining calls from
different source envelopes, so one synthetic assistant message never claims
mixed provenance.

`pi-ai` remains the only target-provider codec. A same-provider replay preserves
the source wire identity. A cross-provider replay is recognized from truthful
source metadata, allowing the target adapter to normalize the call/result pair
for its own length and character constraints. Tenon does not post-process the
materialized provider payload.

Unavailable or corrupt provider-call history degrades that exchange to the
existing bounded historical evidence path rather than killing the Turn.

### Clean cut and specifications

The persisted `modelCall` shape changes atomically with the kernel and
projector. Existing pre-release Agent userData is reset; no optional envelope,
legacy Item-ID fallback, or dual projection path ships. Current specifications
replace the rule that preserves ordinary provider IDs as canonical IDs with the
two-identity contract and record `pi-ai` as transport-only adapter authority.

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
  remain unique within visible history and must not rely on a provider-specific
  character allowlist.
- Incorrect source metadata recreates the current failure by causing `pi-ai` to
  treat cross-provider history as same-model history.
- Raw provider IDs are untrusted and may be very large. Admission must bound
  durable wire evidence without turning an inspection concern into a dead Turn.
- The protocol, projector, and runtime files overlap other active Agent work;
  implementation starts only from the final merged shared-interface baseline.

## Verification

- Codec tests reject missing, malformed, and oversized provider-call envelopes
  while renderer projection proves the envelope stays Host-private.
- Kernel tests prove every provider call receives a distinct UUIDv7 internal ID
  while exact provider IDs pair live assistant calls and results, including
  empty IDs, duplicates, parallel batches, retry, cancellation, and steering.
- Real `pi-ai` serializer tests inspect OpenAI Responses -> Anthropic Messages
  and Anthropic Messages -> OpenAI Responses request bodies, including IDs with
  `|`, IDs longer than Anthropic's limit, and normalized-ID collision cases.
- Context projection tests preserve recorded source metadata and exact pairing
  across restart, fork, compaction, redacted replay, unavailable payloads, and
  mixed-provider Thread history.
- Thread-service tests prove historical calls are never re-executed and new
  tools execute exactly once after a provider switch.
- Run `bun run typecheck`, `bun run test:core`, `bun run test:renderer`,
  `bun run docs:check`, and focused `bun run test:e2e` coverage before ready.

## Open questions

None. Provider-specific wire validation remains an adapter responsibility; the
Host contract is fixed to bounded opaque correlation plus internal UUID
authority.

## Implementation checklist

- [ ] Rebase after the overlapping shared Agent protocol claim merges, then
      regenerate the implementation queue from current search hits.
- [ ] Cut the persisted model-call envelope and codec in one change.
- [ ] Separate active provider correlation from Host execution identity.
- [ ] Rebuild durable history with truthful source metadata and paired wire IDs.
- [ ] Reset isolated pre-release Agent userData and verify clean startup.
- [ ] Add provider-switch, lifecycle, serializer, and non-reexecution coverage.
- [ ] Fold the design into current specifications and archive this plan at the
      integration gate.
