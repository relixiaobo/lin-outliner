# Provider transient request retry

This is shape **(a): one complete feature in one PR**. The PR adds bounded,
Codex-style request retries for transient OpenAI Responses failures before the
provider stream emits any event, while preserving Tenon's separate, stricter
stream-replay boundary after text or tool calls begin.

## Goal

- Retry transient OpenAI Responses request failures four times after the
  initial attempt, for five total attempts.
- Cover HTTP `5xx` responses, including Cloudflare `524`, plus recognizable
  transport timeouts and connection failures.
- Use an abortable exponential backoff starting at 200 ms with a factor of two
  and bounded jitter.
- Keep intermediate failed attempts out of the event log and canonical render
  projection, while showing the current retry as one runtime-only transcript-tail
  status row.
- Limit request-layer retries to failures that happen before the provider stream
  emits any event. Keep the existing one-time replay for a started stream that
  terminates before material text or tool output.
- Preserve all completed document mutations and tool results from earlier model
  rounds in the same Run.

## Non-goals

- The new Codex-style request budget does not retry `429`,
  authentication/authorization failures, invalid requests, context-window
  errors, or user cancellation.
- No request-layer retry after any provider stream event. A started stream is
  eligible only for the existing one-time premature-termination replay, and only
  while it contains start/thinking events rather than material output.
- No automatic replay after assistant text, a tool-call fragment, or a complete
  tool call has become material output for the current provider attempt.
- No Codex-style history-aware replay of partially completed sampling requests.
  Tenon's current event adapter does not yet reconstruct a retry prompt from
  accepted output items and tool results.
- No persisted retry counter, historical retry rows, or provider settings UI.
- No attempt to fix the upstream proxy's Cloudflare timeout or SSE heartbeat
  behavior.

## Design

### Separate request failures from stream termination

`agentStreamAbort.ts` currently grants one retry to OpenAI/Azure Responses
streams that terminate before a terminal response event, provided no material
text or tool output was emitted. Keep that stream-termination budget unchanged.

Add a separate request-failure budget:

- request failures: four retries after the initial attempt;
- premature stream termination: one retry after the initial attempt;
- counters are independent so one class cannot consume the other's budget.

The request retry follows Codex's provider policy rather than setting pi-ai's
single `maxRetries` option globally. Tenon's runtime setting is shared across
providers, and the OpenAI SDK's generic retry policy includes `429`; Codex's
request policy deliberately retries `5xx` and transport failures but not `429`.
At the default `providerMaxRetries: null`, pi-ai sends Responses requests with
zero SDK retries, so the outer budget is the effective policy. An explicit
non-null provider setting remains a separate operator override with the SDK's
existing retry semantics.

### Retry classification

Classify an attempt as request-retryable only when all of these are true:

1. The model uses `openai-responses` or `azure-openai-responses`.
2. The attempt ended with an error rather than abort.
3. No provider stream event was emitted.
4. No complete tool call was observed.
5. The error is either:
   - an OpenAI/Azure OpenAI formatted HTTP status in the `500..599` range; or
   - a bounded, explicit transport signature such as connection reset, socket
     closure, fetch/network failure, or request timeout.

Do not infer retryability from generic words such as `failed` or `error`. Keep
the classifier narrow so configuration, authentication, quota, and semantic
provider errors fail immediately.

### Backoff and cancellation

Before each request retry, wait with the Codex backoff shape:

- retry 1: approximately 200 ms;
- retry 2: approximately 400 ms;
- retry 3: approximately 800 ms;
- retry 4: approximately 1600 ms;
- each delay receives bounded `0.9..1.1` jitter.

The wait observes the Run's abort signal. Stopping the conversation settles the
stream as aborted immediately and prevents another provider attempt. Tests use
an injected zero-delay calculation while separately pinning the pure delay
bounds.

### Event and tool safety

Request retries happen only before any provider stream event, so failed request
attempts contribute no events to the projection. For the separate premature
stream-termination retry, discard buffered start/thinking events and reset
attempt-local partial state before opening the next source stream. Once text or
any tool-call stream event begins, flush buffered events and make the attempt
non-retryable. This keeps the existing invariant that automatic retry cannot
duplicate a visible answer or execute the same tool call twice.

Earlier completed model rounds and their tool mutations remain canonical in the
Run. The retry only replaces the current provider attempt after the latest tool
results.

### Runtime retry status

The stream wrapper reports a runtime-only retry lifecycle to the owning
conversation and Run. This uses a main-to-renderer `provider_retry` event rather
than an agent event-log record:

- `retrying` is emitted when a request or premature-stream retry is selected;
- request retries expose attempts `1/4` through `4/4`, while the existing stream
  replay exposes `1/1`;
- repeated retries update the same status in place;
- concurrent Runs are tracked independently by `runId`; the most recently
  updated retry owns the single visible row, and clearing it falls back to any
  earlier Run that is still retrying;
- `cleared` is emitted when the replacement attempt produces its first valid
  provider event, reaches a terminal outcome, or is aborted;
- switching, hydrating, or closing the selected conversation also clears the
  renderer's transient state.

The renderer places one neutral, polite live-region row after the transcript and
before the composer. It reads `Reconnecting n/m` (localized), remains outside the
virtualized transcript projection, and disappears without leaving history once
the retry clears.

### Exhausted failure placement

When all retries are exhausted, clear the transient retry row before exposing the
terminal assistant failure. The failed assistant turn renders in logical order:

1. thinking and tool process;
2. any generated response content;
3. the final provider error;
4. the action toolbar, with `Retry response` first.

Run failures never use the panel's top-level operational error banner. The
terminal error remains attached to the assistant message so the retry action is
adjacent to the failure at the end of the response.

### Specification

Update `docs/spec/agent-pi-mono-implementation.md` with the effective runtime
contract:

- four request retries for pre-stream Responses `5xx`/transport failures;
- request retries only before the first provider stream event;
- one retry for started but pre-material-output premature Responses termination;
- no `429` retry in the new outer budget;
- no automatic retry after material output;
- abortable exponential backoff.
- runtime-only retry lifecycle and transcript-tail status placement;
- terminal failure ordering after generated content and before reply actions.

## Open questions

None. The retry budgets and safety boundary are ratified: five total request
attempts, while history-aware partial-stream replay remains out of scope.

## Files

- `src/main/agentStreamAbort.ts`
- `src/core/agentTypes.ts`
- `src/main/agentRuntime.ts`
- `src/renderer/agent/runtime.ts`
- `src/renderer/ui/agent/AgentChatPanel.tsx`
- `src/renderer/ui/agent/AgentMessageRow.tsx`
- `src/renderer/ui/agent/AgentProviderRetryStatus.tsx`
- agent transcript styles and English/Simplified Chinese messages
- `tests/core/agentStreamAbort.test.ts`
- focused runtime and renderer tests
- `docs/spec/agent-event-log-rendering.md`
- `docs/spec/agent-pi-mono-implementation.md`
- this plan

No dependency, persisted agent-event protocol, provider settings,
`docs/TASKS.md`, or `CHANGELOG.md` change is required.

## Risks

- A persistent Cloudflare `524` can hold each attempt for about two minutes, so
  exhausting five attempts may take roughly ten minutes. The chain remains
  user-cancellable.
- A `524` means the gateway timed out while its origin may still be computing;
  retries can increase provider cost even though no result reached Tenon.
- Transport errors are string-formatted by the provider adapter. The local
  classifier must stay narrow and covered by exact positive and negative tests.
- Retrying after material output would risk duplicate text or tool execution;
  guard tests must pin the no-retry boundary.
- A missing terminal clear could leave stale transient UI. Stream lifecycle,
  abort, renderer hydration, conversation switching, and close paths all clear
  the status and are covered by focused tests.

## Collision check

- Open PR #394 claims field-value-child renderer, spec, and test work. It does
  not overlap the agent runtime, chat UI, i18n, or specs in this change.
- The runtime-only shared event union in `src/core/agentTypes.ts` is the only
  infrastructure-ownership surface; its shape is part of this ratified plan and
  does not alter the persisted agent-event protocol.
- Result: no overlap.

## Checklist

- [ ] Add independent request and stream retry budgets.
- [ ] Classify Responses `5xx` and bounded transport failures; exclude `429`
  and other `4xx` errors from the new outer budget.
- [ ] Add abortable 200 ms exponential backoff with bounded jitter.
- [ ] Preserve the pre-stream request boundary plus the no-material-output and
  no-complete-tool-call stream gates.
- [ ] Emit and clear runtime-only retry lifecycle events without persisting them.
- [ ] Render one localized transcript-tail status row and update it in place.
- [ ] Render exhausted failures after response content and before reply actions.
- [ ] Cover success after retries, exhausted budget, negative status classes,
  material output, completed tool calls, cancellation, runtime state, and UI
  ordering.
- [ ] Update the pi-mono implementation and event-log rendering specs.
- [ ] Run typecheck, focused core tests, the full core suite, and docs check.
