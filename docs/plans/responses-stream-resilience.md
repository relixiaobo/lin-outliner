# Responses stream resilience

## Goal

Give the OpenAI-Responses path the same mid-stream tolerance Codex has, so a
third-party relay hiccup no longer kills a Turn. Concretely: the failure of
2026-08-10 (two Turns dead with `stream_read_error` against the `cc-switch` →
`sub2api.wisebox.ai` relay, while the *same relay* is fine under Codex CLI) must
recover on its own.

Codex survives the same relay because of three behaviours we lack, all verified
in `codex-latest`:

- **Non-standard SSE frames are skipped, not fatal.** `codex-api/src/sse/responses.rs`
  `continue`s on a frame it cannot parse and ignores unknown `type` values; only
  `response.failed`, `response.incomplete`, stream close, and idle timeout are
  errors. The `openai` SDK we reach through `pi-ai` throws on **any** data frame
  carrying an `error` key (`node_modules/openai/core/streaming.js`, the
  `if (data && data.error)` branch) regardless of frame type.
- **Every stream error is retryable, unconditionally.** `CodexErr::is_retryable`
  returns true for the whole `Stream`/`ResponseStreamFailed`/`ConnectionFailed`
  family, and the sampling loop in `core/src/session/turn.rs` re-issues the full
  request from history no matter how much the dead attempt already emitted.
  Budget is `DEFAULT_STREAM_MAX_RETRIES = 5`.
- **Idle timeout.** `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000`, and hitting it
  feeds the same retry loop.

## Non-goals

- No change to behaviour against official `api.openai.com` — every change here
  is gated on `isCustomOpenAIResponsesEndpoint`.
- No fork, patch, or version bump of `@earendil-works/pi-ai`. The injection
  points it already exposes (`StreamOptions.fetch`, `onPayload`, `onResponse`)
  are sufficient.
- No change to the tool-call side-effect guard: a stream whose tool calls all
  finished parsing keeps its current salvage/no-retry treatment.
- Not fixing the relay's schema rewriting (the observed `node_create` calls
  arrive with every mutually-exclusive parameter filled and both camelCase and
  snake_case aliases present, even though we send neither `strict` nor a
  full `required`). That is upstream behaviour; it is a symptom recorded here,
  not work in this plan.

## Background — what happens today

Ordered by where the failure passes through:

1. `piStreamSimple` runs the `openai` SDK against the relay. HTTP is 200; the
   relay injects a frame carrying `error` mid-stream. The SDK throws
   `APIError` whose message is the relay's raw string, `stream_read_error`.
2. `pi-ai`'s `openai-responses` adapter catches it and settles the message with
   `stopReason: 'error'`, `errorMessage: 'stream_read_error'`.
3. `wrapStreamWithAbortSettling` in `src/main/agent/runtime/kernel/retryPolicy.ts`
   asks `retryOutcomeForResponsesError` what to do. Three independent guards
   each say "do not retry":
   - the `sawMaterialOutput` early return — both dead Turns had already emitted
     `toolcall_start`/`text_start`, so this alone is decisive;
   - `isTerminatedResponsesStreamError` matches only `terminated`,
     `stream ended before a terminal response event`, and `terminated while`,
     none of which is `stream_read_error`;
   - `MAX_RETRYABLE_RESPONSES_TERMINATIONS` is 1 against Codex's 5.
4. The Turn is recorded `failed` with `{"message":"stream_read_error","code":"runtime_failure"}`.

Also relevant: `providerStreamOptionsFromRuntimeSettings` in
`src/main/agent/capabilities/agentSettings.ts` never sets `fetch`, and the
runtime records `timeoutMs: null` — there is no idle timeout anywhere on the
streaming path.

## Design

Build order matters (A7): the fetch layer must exist before the retry
classification is widened, because a widened classifier with a still-fatal noise
frame just burns retries on a stream that could have been salvaged in place.

### Step 1 — SSE sanitizing fetch

New module `src/main/agent/runtime/sseResilientFetch.ts`, exporting
`createResilientResponsesFetch(options)` returning a `FetchFunction`.

- Delegate to `globalThis.fetch`. If the response is not `text/event-stream`,
  return it untouched.
- Otherwise pipe the body through a `TransformStream` that buffers **one frame
  at a time** (to the `\n\n` boundary) and no more — never aggregate across
  frames, or streaming latency regresses.
- Per frame, parse the `data:` payload as JSON. Drop the frame — and report it
  through the `onNoiseFrame` callback — when it carries an `error` key **and**
  its `type` is not one of `response.failed`, `response.incomplete`,
  `response.completed`. Every other frame is forwarded **byte-for-byte**; do not
  re-serialize, or unknown relay fields are silently rewritten.
- Handle: multi-line `data:`, `event:` lines, comment lines (`:` prefix), the
  `[DONE]` sentinel, and frames split across chunks.
- A frame whose JSON does not parse is forwarded unchanged, not dropped — our
  concern is relay-injected error frames, not malformed content we might be
  misreading.

This is deliberately narrower than Codex, which drops unparseable frames
outright. Forwarding them keeps the SDK's own handling authoritative for
anything that is not the specific pathology we are fixing.

### Step 2 — Stream idle timeout

Same module, same wrapper. If no chunk arrives within `idleTimeoutMs`, abort the
underlying request so the stream terminates as an error — which Step 3 then
classifies as retryable. Default **300000 ms**, matching Codex; high reasoning
effort legitimately produces long silent gaps, and a shorter value kills healthy
Turns.

### Step 3 — Retry classification and budget

In `src/main/agent/runtime/kernel/retryPolicy.ts`:

- Replace `isTerminatedResponsesStreamError` with
  `isRetryableResponsesStreamError`, inverting the default. An error that killed
  an already-established stream is retryable **unless** it is semantically
  final:

  ```
  const failure = classifyModelFailure(message)
  if (failure?.kind === 'contextOverflow' || failure?.kind === 'aborted') return false
  if (failure?.status !== undefined && failure.status >= 400
      && failure.status < 500 && failure.status !== 429) return false
  return true
  ```

  Note why the status check cannot lean on `failure.kind` alone:
  `classifyErrorMessage` derives its kind by scraping an HTTP status out of the
  message string, so a bare `stream_read_error` lands in `badRequest` with no
  status — indistinguishable from a real 400 if you match on kind.

- Both existing callers move to the new predicate:
  `retryOutcomeForResponsesError` and `salvageTerminatedCustomResponsesToolUse`.
  Widening salvage is intended and safe — it still requires every tool call in
  the message to have completed parsing.

- `MAX_RETRYABLE_RESPONSES_TERMINATIONS` 1 → **3**. Not Codex's 5: a relay blip
  clears in one or two attempts, and five sequential re-sends of a 70k-token
  request is a long stall in an interactive app.

- Give the `retry-stream` branch the same backoff the `retry-request` branch
  has. It currently loops with no delay.

- Leave `maxStreamRetries: providerOptions.maxRetries` in `PiTurnExecutor`
  alone: an explicit user setting keeps winning; only the default moves.

### Step 4 — Diagnostics

This incident was reconstructed entirely from `TurnDiagnostics`
(`providerCalls[].transportResponse` / `.response`), and neither sanitization
nor stream retries would have shown up there. Add
`captureStreamNoiseFrame` alongside `captureProviderRetry`, recording per
provider call: when the frame arrived, its `type`, and a redacted snippet
through the existing secret-scan budget helper — never the raw frame.

`captureProviderRetry` already fires for stream retries; confirm the
`retry-stream` path reaches it with the new budget.

### Step 5 — Retry after the stream already emitted

Steps 1–4 alone cannot rescue the reported failure whenever the relay really
closes the connection: both dead Turns had already emitted `toolcall_start` or
`text_start`, and `retryOutcomeForResponsesError`'s `sawMaterialOutput` early
return refuses the retry before any of the other conditions are consulted. This
step removes that guard. It is unconditional — Step 1 may well rescue most of
these in place, but "the relay's stream is unrecoverable once it spoke" is not
a state we should model as fatal either way.

- Drop the `sawMaterialOutput` guard from `retryOutcomeForResponsesError`. Keep
  the `completedToolCallIds.size > 0` guard: tool execution happens in
  `runKernelAgent` *after* the stream settles, so an interrupted stream has no
  executed side effects, and salvage already covers the all-tool-calls-complete
  case.
- `streamAssistantResponse` in `src/main/agent/runtime/kernel/kernel.ts` pushes
  a new assistant message on every `start` event. On a retry it must instead
  replace the trailing partial, and emit a new kernel event —
  `message_restart`, carrying the interrupted partial — before doing so.
  `AgentEvent` lives in `src/main/agent/runtime/kernel/types.ts`; it is a
  main-process type, not the `src/core` protocol surface, so adding a variant
  here is in scope.
- The normalizer in `PiTurnExecutor` handles `message_restart` by closing out
  the interrupted items and clearing its pointers, so the re-sent stream opens
  fresh ones. Two facts make this the cheap path rather than a recorder change:
  `completeAssistant` already nulls `activeMessageItem` / `activeReasoningItem`
  at `message_end` (one stream, one item — a retry simply never reaches that
  reset), and `recorder.completed` rewrites item content from the **full
  message** rather than the accumulated deltas, so deltas are a live preview and
  the committed content is authoritative. Without this, the interrupted item
  never completes and the re-sent deltas concatenate onto it.
- The user-facing result is an interrupted segment, the existing retry
  indicator, then a fresh segment — exactly what Codex shows around
  `Reconnecting... 1/5`. `showProviderRetry('stream', …)` →
  `context.onProviderRetry` already carries that signal; do not redraw
  silently.

No protocol-surface change is required anywhere in this step. If an
implementation detail nonetheless starts reaching into
`src/core/agent/protocol.ts` or `src/core/agent/codec.ts`, that is the signal
the approach drifted — stop and re-read this step rather than widening the PR.

## Settled decisions

Recorded so no one re-opens them mid-build:

- Stream retry budget is **3**, not Codex's 5 — interactive stall budget.
- Idle timeout is **300000 ms**, matching Codex — shorter kills legitimate long
  reasoning gaps.
- Sanitization is **narrower than Codex**: unparseable frames are forwarded, not
  dropped. Only frames that both carry `error` and are not a terminal response
  event get removed.
- A retry after the stream already emitted shows an **interrupted segment plus a
  fresh one**, not a silent redraw. Suppressing the interrupted segment would
  need a rollback the recorder does not have; showing it is also what Codex
  does, and the retry indicator explains it.

## Open questions

None. Every judgment call is settled above; the plan runs start to finish
without a decision point.

## Verification

New `tests/core/sseResilientFetch.test.ts`:

- "forwards standard responses frames byte-for-byte"
- "drops a relay error frame and keeps reading to response.completed"
- "keeps response.failed fatal"
- "forwards a frame whose data is not valid JSON"
- "reassembles a frame split across chunks"
- "surfaces an idle timeout as a stream error"
- "leaves non-event-stream responses untouched"

Extend `tests/core/kernelRetryPolicy.test.ts`:

- "retries a stream error outside the legacy termination allowlist"
- "does not retry a context-overflow failure"
- "does not retry a 400 that carries a status"
- "retries a 429 that carries a status"
- "stops after the third stream retry"
- "still refuses to retry once a tool call finished parsing"
- "retries a stream that already emitted text"

Extend `tests/core/agentPiTurnExecutor.test.ts`:

- "message_restart completes the interrupted items and opens fresh ones"
- "a retried stream does not concatenate onto the interrupted message"

Extend `tests/core/openAIResponsesCompat.test.ts` for the gating: the resilient
fetch is installed for a custom base URL and absent for `api.openai.com`.

Real-run verification: re-run the model pricing research task against the
`cc-switch` relay and read the resulting Turn diagnostics for sanitized frames,
retry events, and final stop reason. A Turn that previously died on
`stream_read_error` must now either never see the frame as fatal or recover
through a stream retry.

`bun run typecheck` + `bun run test:core` + `bun run docs:check` before ready.

## Risks

| Risk | Mitigation |
|---|---|
| Sanitizer swallows a real error | Only frames that carry `error` *and* are not a terminal response event are dropped; `response.failed` stays fatal; every dropped frame lands in diagnostics |
| Error message gets vaguer (failure now surfaces at stream close, not at the frame) | Carry the first dropped frame's redacted content into the terminal error message |
| Retries re-bill a large request | Budget of 3, with backoff; Codex accepts the same trade at 5 |
| Byte-level SSE rewriting corrupts a stream | Forward untouched frames as raw bytes, never re-serialize; frame-splitting covered by test |
| Step 5 duplicates rendered output | `message_restart` closes the interrupted items and opens fresh ones; the retry indicator explains the seam |
| Step 5's kernel event ripples wider than expected | `AgentEvent` is main-process-only; any drift toward `src/core/agent/protocol.ts` means the approach went wrong, not that the PR should grow |

## Execution checklist

- [ ] Step 1 — `sseResilientFetch.ts` with frame-level sanitization
- [ ] Step 2 — idle timeout in the same wrapper
- [ ] Wire `fetch` through `providerStreamOptionsFromRuntimeSettings`, gated on
      `isCustomOpenAIResponsesEndpoint`; override in `PiTurnExecutor` with the
      diagnostics-bound callback
- [ ] Step 3 — `isRetryableResponsesStreamError`, budget 3, stream-retry backoff
- [ ] Step 4 — `captureStreamNoiseFrame` in `TurnDiagnostics`
- [ ] Step 5 — drop the `sawMaterialOutput` guard; `message_restart` through
      kernel and normalizer
- [ ] Unit tests above; `typecheck` + `test:core` + `docs:check`
- [ ] Real-run reproduction against the relay; read diagnostics
