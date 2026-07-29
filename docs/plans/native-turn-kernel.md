# Native Turn Kernel — absorb `pi-agent-core`, keep `pi-ai` as transport

Shape: **(a) ONE complete feature in one PR.** The internal stages below are
build order inside that single PR, not separate releases.

Prerequisite: PR #444 (`codex-3/agent-context-runtime-completion`) is merged.
Every file/line reference below is against that branch's tip (`79c87380`);
rebase references if main has moved.

## Goal

Replace the `@earendil-works/pi-agent-core` dependency (954 lines of dist:
`agent.js` 410 + `agent-loop.js` 544) with a Tenon-owned turn kernel, structured
as small ports in the style of koma's kernel (`~/Coding/koma/packages/core`):
a pure loop that projects context, streams one model call, runs one tool batch,
and consults policy — with **one** retry owner and typed error classification.

`@earendil-works/pi-ai` stays, demoted to pure transport behind a
`ModelGateway` port. The canonical protocol (`src/core/`), Items, rollouts,
diagnostics payload schema, renderer, and tool authoring semantics do not
change. After this PR, a byte-for-byte identical normalized Item stream comes
out of the same inputs — only the loop's owner changes.

North star (standing project goal, PM 2026-07-29): make the runtime (verb)
layer as clean, clear, simple, and elegant as the data (noun) layer already is —
one owner per concern, ports over wrappers, typed values over string matching.
This plan is the first structural step; it removes the largest own-vs-wrap
tension in the codebase.

Why now (evidence from the 2026-07-29 incident + PR #444 review):

- Two stacked retry owners produced F3; the fix suppresses pi's inner loop with
  `maxRetries: 0` (`PiTurnExecutor.ts`, `configuredStream`) — a hack that only
  exists because the loop is rented.
- Retry classification is regex-on-message at the wrong layer
  (`agentStreamAbort.ts:458` `isRetryableResponsesRequestError`); R2 was fixed
  by editing a regex.
- Diagnostics capture provider facts by *intercepting* pi callbacks
  (`onPayload`/`onResponse`/`captureEvent`) instead of owning the call sites.
- The `agentStreamAbort.ts` wrapper (~500 lines) re-implements retry/abort
  semantics *around* a loop it cannot see into.

## Non-goals

- No provider-layer replacement. `pi-ai` remains the only transport
  (`piStreamSimple` / `piCompleteSimple`, provider registry, OAuth, model
  catalog, usage/cost). The thread-name path (`completeThreadName` →
  `piCompleteSimple`) is transport-only and stays as-is.
- No koma code dependency. We take the port shapes, not the packages.
- No change to steering semantics, event ordering, canonical Item shapes,
  diagnostics payload schema (`codec.ts` untouched), renderer protocol, or the
  tool authoring surface beyond an import-specifier swap.
- No permission-model change. Tenon's Full-Access + capability-boundary model
  (`docs/spec/agent-tool-permissions.md`) is deliberate; koma's per-call
  allow/ask/deny approval middleware is NOT adopted.
- No renames of `PiTurnExecutor` / `PiEventNormalizer` / `PiAgentRuntime` in
  this PR (churn control; a later mechanical rename PR may drop the `Pi`
  prefix).

## Current state (verified facts)

**Dependency surface.** 11 files import `@earendil-works/pi-agent-core`:

- Runtime-critical (2): `src/main/agent/runtime/PiTurnExecutor.ts`
  (`Agent`, `AgentOptions`, `AgentState`, `AgentEvent`, message types),
  `src/main/agent/capabilities/agentStreamAbort.ts` (`StreamFn`).
- Type-only tool vocabulary (9): `agentSkills.ts`, `agentImageGenerationTool.ts`,
  `agentToolEnvelope.ts` (`AgentToolResult`, `AfterToolCallResult`),
  `agentNodeToolVisibility.ts`, `agentLocalTools.ts`, `agentNodeTools.ts`,
  `agentTools.ts`, `runtime/ToolRuntime.ts`, `automations/AutomationTool.ts` —
  all import only `AgentTool` / `AgentToolResult` / `AfterToolCallResult`.

**The executor is already programmed against an interface.**
`PiTurnExecutor.ts:125-131` defines `PiAgentRuntime`
(`state.errorMessage` / `subscribe` / `abort` / `steer` / `prompt`), and
`PiTurnExecutorOptions.createAgent` (`:108`) injects the factory. The default is
`new Agent(options)`. Tests already exploit this seam
(`tests/core/agentPiTurnExecutor.test.ts`). **This is the surgical cut: the
kernel implements `PiAgentRuntime`; the executor swaps the default factory.**

**The Agent contract actually used** (single construction site,
`PiTurnExecutor.ts` ~`:258`):

- `initialState: { systemPrompt, model, thinkingLevel, tools, messages }`
- `streamFn` — currently `createAbortSettledStreamFn(configuredStream, {...})`
- `getApiKey`
- `onPayload(payload, model)` — payload-profile transform
  (`agentProviderPayload`) + `diagnostics.captureProviderRequest`
- `onResponse(response)` — `diagnostics.captureTransportResponse`
- `transformContext` — per-model-call re-projection (evidence refresh, frozen
  tool projections, budget/compaction via
  `projectCanonicalProviderContext`)
- `steeringMode: 'all'`, `sessionId: cacheAffinity` (→ `prompt_cache_key`),
  `maxRetryDelayMs`, `toolExecution: 'parallel'`

**Event vocabulary the normalizer consumes** (`PiEventNormalizer`,
`PiTurnExecutor.ts:655+`): `message_start`, `message_update` (with
`assistantMessageEvent`: `text_delta`, `thinking_delta`, tool-call deltas),
`message_end`, `tool_execution_start`, `tool_execution_end`, `agent_end`
(terminal `stopReason`/`errorMessage` from last assistant message). The
diagnostics collector additionally receives every raw event via
`diagnostics.captureEvent(event)`.

**pi-agent-core loop semantics to preserve** (from `dist/agent-loop.js`):
steering queue drained at loop start and between iterations ("inject before
next assistant response"); parallel tool execution with **ordered
finalization** (`Promise.all` over calls, results appended in call order);
every `tool_call` must resolve to a `tool_result` before the next model call.

**agentStreamAbort semantics to absorb** (`agentStreamAbort.ts`):

- Request vs stream retry budgets: `canRetryResponses = retrySource &&
  isOpenAIResponsesModel(model)`; defaults
  `MAX_RETRYABLE_RESPONSES_REQUEST_FAILURES = 4`,
  `MAX_RETRYABLE_RESPONSES_TERMINATIONS = 1` (`:41-42`); user override via
  `providerMaxRetries` (both budgets), exponential delay with jitter capped by
  `maxRetryDelayMs`.
- Retryable classification: HTTP 429/5xx + transport-error regexes (`:458`).
- Buffer-before-retry: `shouldBufferBeforeRetryDecision` — suppress partial
  events until the retry decision; once material output was flushed, the stream
  settles instead of retrying.
- Abort settling: on abort mid-stream, synthesize a settled partial
  `AssistantMessage`, close open tool calls (`completedToolCallIds`).
- Context-overflow recovery: `onContextOverflow` → `context.compactContext
  ('providerOverflow', activeAdmissionCursor(...))` → on success, re-run
  `transformContext()` and retry the call (post-#444 staged-compaction
  contract).
- Retry observation: `onProviderRetry({phase, kind, attempt, maxRetries})` →
  `diagnostics.captureProviderRetry` + `context.onProviderRetry` (renderer
  status).

## Design

New directory `src/main/agent/runtime/kernel/`. Five files, each a port or the
loop. All types Tenon-owned; `pi-ai` types (`Model<Api>`, `Context`,
`Message`, `AssistantMessage`, usage) remain the transport vocabulary — they
already permeate the projection layer and are NOT being replaced.

### 1. `kernel/types.ts` — owned vocabulary

- Re-declare the tool authoring types with identical structure:
  `AgentTool`, `AgentToolResult`, `AfterToolCallResult`, `StreamFn`. They are
  structurally identical to pi-agent-core's; the 9 capability files change
  **only the import specifier**. Grep-verifiable completion:
  `rg "@earendil-works/pi-agent-core" src/` → zero hits.
- `KernelEvent`: exactly the union the normalizer + diagnostics consume today
  (`agent_start`, `turn_start`, `message_start`, `message_update`,
  `message_end`, `turn_end`, `tool_execution_start`, `tool_execution_end`,
  `agent_end`), same field shapes. `PiEventNormalizer.handle` and
  `TurnDiagnosticsCollector.captureEvent` switch their parameter type to
  `KernelEvent` with no logic change.
- `ModelError`: typed classification owned at the gateway boundary —
  `{ kind: 'contextOverflow' | 'rateLimit' | 'serverError' | 'transport' |
  'badRequest' | 'aborted'; status?: number; message: string }`.
  The existing regexes move INTO the gateway adapter as the single place that
  maps pi-ai's string errors to `ModelError` (koma's lesson: errors are values
  at the port, strings only at the adapter edge).

### 2. `kernel/ModelGateway.ts` — transport port

```ts
interface ModelGatewayRequest {
  model: Model<Api>;
  context: Context;            // already payload-profile agnostic
  options: SimpleStreamOptions; // sessionId, cacheRetention, timeout, signal…
}
interface ModelGateway {
  stream(request: ModelGatewayRequest): AsyncIterable<AssistantMessageEvent>;
  // errors THROWN as ModelError, never yielded (koma gateway contract)
}
```

`PiModelGateway` implements it over `piStreamSimple` with `maxRetries: 0`
pinned (retry is the kernel's job, permanently, not a suppression hack), maps
thrown/streamed errors to `ModelError`, and exposes the two capture hooks as
constructor options: `onPayload` (payload-profile transform + provider-request
capture) and `onResponse` (transport capture). These become first-class gateway
concerns instead of pi callbacks.

### 3. `kernel/retryPolicy.ts` — the single retry owner

Absorbs `agentStreamAbort.ts` behavior verbatim: request/stream budgets and
defaults, delay schedule + jitter + cap, buffer-before-retry, abort settling,
`onProviderRetry` observation. Exposed as one function the kernel calls around
`gateway.stream`. `ModelError.kind === 'contextOverflow'` is NOT retried here —
it is returned to the loop for the recovery path (see kernel step 4).
`tests/core/agentStreamAbort.test.ts` moves to
`tests/core/kernelRetryPolicy.test.ts` with assertions unchanged — the suite IS
the semantics spec.

### 4. `kernel/kernel.ts` — the loop (~200 lines, zero business logic)

Per iteration (koma `run()` shape, Tenon semantics):

1. **Drain steering queue** → emit queued user `Message`s into the working
   message list (preserves pi's "inject before next assistant response";
   `steeringMode: 'all'` means steer is accepted at every iteration boundary).
2. **Project**: `context = await transformContext()` (already rebuilds
   evidence, frozen projections, budget plan, preflight compaction — unchanged
   contract from #444). koma's `contextOverride` corresponds to the re-run
   after overflow recovery below.
3. **Stream via retryPolicy(gateway)** → on success an `AssistantMessage`;
   emit `message_start` / `message_update` / `message_end` with today's exact
   cadence (the normalizer's item lifecycle depends on it).
   - On `ModelError contextOverflow`: call
     `compactContext('providerOverflow', activeAdmissionCursor(turn))`; if it
     staged+committed, loop back to step 2 (fresh projection), else terminate
     the turn with the error.
   - On retry-budget exhaustion or non-retryable error: terminate with error
     (normalizer sees `agent_end` with `stopReason: 'error'`).
4. **No tool calls** → emit `turn_end` + `agent_end`, return (Tenon has no
   koma `Controller.onNoToolCalls` continuation — Goal continuation lives in
   `ThreadService`, deliberately outside the kernel).
5. **Tool batch**: run all calls with `toolExecution: 'parallel'` semantics —
   `Promise.all`, ordered finalization, `tool_execution_start`/`end` per call,
   every call resolved before the next model call. Reuses the existing tool
   invocation path (`AgentTool.execute` shape) — the ToolRunner port is this
   step extracted, not a new tool system.
6. `turn_end`; next iteration.

Abort (`signal`) at any await: settle partial state exactly as
`agentStreamAbort` does today, emit `agent_end`, return.

### 5. `kernel/NativeAgentRuntime.ts` — the compatibility shell

Implements `PiAgentRuntime` (`state` / `subscribe` / `steer` / `prompt` /
`abort`) by driving `kernel.run` and fanning events to subscribers. `steer(msg)`
enqueues; `prompt(msg)` seeds the message list and runs the loop to completion;
`state.errorMessage` mirrors the terminal error. This keeps
`PiTurnExecutor.execute` structurally unchanged.

### Executor diff (the whole integration)

In `PiTurnExecutor.ts`:

- default factory: `new Agent(options)` → `new NativeAgentRuntime(...)` built
  from `PiModelGateway` + `retryPolicy` + the same wiring values
  (`getApiKey`, `sessionId`, `transformContext`, capture hooks, providerOptions).
- Delete the `createAbortSettledStreamFn(...)` wrapping and the
  `{ ...options, ...providerOptions, maxRetries: 0 }` spread in
  `configuredStream` (both subsumed).
- Imports of `Agent`/`AgentEvent` etc. → `kernel/`.

`ThreadService` does not change. `codec.ts` does not change.

### Dependency removal

`package.json` / `bun.lock`: drop `@earendil-works/pi-agent-core`. These are
infrastructure-ownership files — this PR *is* the coordinated change; other
agents rebase after merge. `@earendil-works/pi-ai` stays pinned.

## Verification

1. **Ported suites**: `agentPiTurnExecutor.test.ts` (incl. the #444 additions:
   steering-refresh, finalize-completed, retry activities) must pass against
   the native runtime with zero assertion edits — the `createAgent` seam means
   most of it already targets the interface. `agentStreamAbort.test.ts` →
   `kernelRetryPolicy.test.ts`, assertions unchanged.
2. **Golden Item-stream parity** (the load-bearing check): a fixture-driven
   test that feeds a scripted gateway (canned `AssistantMessageEvent`
   sequences: text + thinking deltas, parallel tool calls, mid-stream retry,
   overflow → compaction, steering injection, abort) through BOTH the old
   `Agent` (fixture recorded before the swap, committed as JSON) and the native
   kernel, asserting the normalized `ThreadItem` stream and the
   `TurnDiagnosticsCollector` activity list are deep-equal.
3. **Full gates**: `bun run typecheck`, `test:core`, `test:renderer`,
   `docs:check`, `rg "@earendil-works/pi-agent-core" src/` → empty.
4. **Real-run smoke** (dev userData, cc-switch provider): one thread with
   mid-turn steering, one parallel-tool turn, one `/clear`, one forced-overflow
   compaction; confirm Model Interactions timeline (model calls, retries,
   batches) renders identically and `cacheRead` stays non-trivial across
   consecutive calls.

## Spec updates (same PR)

- `docs/spec/agent-model-runtime.md`: runtime-ownership section — the turn
  loop, retry policy, and error taxonomy are Tenon-owned under
  `src/main/agent/runtime/kernel/`; `pi-ai` is transport-only behind
  `ModelGateway`; the two-layer retry note from the #444 review fix is replaced
  by "the kernel is the only retry owner".
- `docs/spec/agent-core.md`: one line under Runtime Ownership pointing at the
  kernel directory.

## Build order (stages inside the one PR)

1. `kernel/types.ts` + `kernel/ModelGateway.ts` + `kernel/retryPolicy.ts`,
   with `kernelRetryPolicy.test.ts` ported and green.
2. `kernel/kernel.ts` + `kernel/NativeAgentRuntime.ts`; golden-parity fixture
   recorded against pi-agent-core **before** the swap, then asserted against
   the kernel.
3. Swap the executor default, migrate the 9 type-only imports, delete
   `agentStreamAbort.ts` (logic now in `retryPolicy.ts`), drop the dependency,
   spec updates, full gates + real-run smoke.

## Risks

- **Event-order divergence** (normalizer item lifecycle, diagnostics activity
  order). Mitigation: golden parity fixture is stage-2 blocking; the cadence
  rules (`message_start` before first delta, `tool_execution_*` pairing,
  single `agent_end`) are encoded in it.
- **Steering timing**: pi drains steering at specific points; the kernel must
  not accept a steer mid-model-call into the *current* projection (it lands
  next iteration). Existing steering tests + the #444 `refreshDiagnostics`
  path cover the tail-window case.
- **Partial-stream retry UX**: `shouldBufferBeforeRetryDecision` must move
  verbatim; a behavior change here shows partial garbage to the renderer on
  retried requests.
- **Hidden pi-agent-core behaviors** not exercised by our wiring (e.g. its
  internal message-pruning or non-'parallel' tool modes): out of contract —
  the kernel implements only the options Tenon passes (`steeringMode: 'all'`,
  `toolExecution: 'parallel'`), asserted by the golden fixture.

## Open questions

- None blocking. Two deferred-by-design decisions recorded here: (a) `Pi*`
  renames happen in a later mechanical PR; (b) gateway middleware chain
  (redaction, payload profiles as composable wrappers, koma
  `wrap-gateway.ts` style) is a follow-up once the port exists.

## Checklist

- [ ] Stage 1: types + gateway + retryPolicy, ported retry suite green
- [ ] Stage 2: kernel + NativeAgentRuntime, golden Item-stream parity green
- [ ] Stage 3: executor swap, 9 import migrations, delete agentStreamAbort,
      drop dependency, spec updates
- [ ] `typecheck` / `test:core` / `test:renderer` / `docs:check` green
- [ ] `rg "@earendil-works/pi-agent-core" src/` returns nothing
- [ ] Real-run smoke on cc-switch (steering, parallel tools, compaction,
      cache-hit observation)
