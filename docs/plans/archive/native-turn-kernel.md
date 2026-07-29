# Native Turn Kernel — absorb `pi-agent-core`, keep `pi-ai` as transport

Shape: **(a) ONE complete feature in one PR.** The internal stages below are
build order inside that single PR, not separate releases.

Prerequisite: PR #444 (`codex-3/agent-context-runtime-completion`) is merged.
Tenon file/line references are against that branch's tip (`79c87380`); rebase
references if main has moved. All `agent-loop.js:N` / `agent.js:N` references
are against `@earendil-works/pi-agent-core@0.80.6` `dist/` (exact-pinned in
`package.json`, stable across machines) — **the old code is the spec**; the
Behavioral Contract below is extracted from it and is normative.

## Goal

Replace the `@earendil-works/pi-agent-core` dependency (954 dist lines:
`agent.js` 410 + `agent-loop.js` 544) with a Tenon-owned turn kernel, structured
as four small ports around one pure loop: project context, stream one model
call, run one tool batch, repeat — with **one** retry owner and typed error
classification, and no business logic inside the loop.

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

Provenance (background, non-normative): the ports-around-a-pure-loop
decomposition was validated by koma (`~/Coding/koma`), an in-house agent-
framework experiment whose 137-line kernel showed the shape stays readable at
scale. This plan is self-contained: every normative requirement lives in this
file and the pinned `pi-agent-core` dist. koma is background reading, **not a
reference implementation** — several of its choices (kernel-owned transcript,
`Controller` port, per-call tool approval, its event vocabulary) are
deliberately not adopted here, and no code may be copied from it.

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
  catalog, usage/cost, `validateToolArguments` via `@earendil-works/pi-ai/compat`).
  The thread-name path (`completeThreadName` → `piCompleteSimple`) is
  transport-only and stays as-is.
- No new dependencies. The kernel and its ports are hand-written in-repo;
  nothing is vendored or imported from outside `pi-ai`.
- No change to steering semantics, event ordering, canonical Item shapes,
  diagnostics payload schema (`codec.ts` untouched), renderer protocol, or the
  tool authoring surface beyond an import-specifier swap.
- No behavior improvements smuggled in. Where pi's behavior is odd but Tenon
  depends on it (see BC rules), the kernel reproduces it bug-for-bug. File
  follow-ups instead.
- No permission-model change; no per-tool-call approval gate is introduced
  (Tenon's model: `docs/spec/agent-tool-permissions.md`).
- No renames of `PiTurnExecutor` / `PiEventNormalizer` / `PiAgentRuntime` in
  this PR (churn control; later mechanical rename PR).

## Current state (verified facts)

**Dependency surface.** 12 files import `@earendil-works/pi-agent-core`
(count them with a multi-line-safe search — `rg -l "pi-agent-core" src/` —
NOT a single-line `from '...'` grep, which misses split imports; an earlier
draft of this plan undercounted exactly that way):

- Runtime-critical (2): `src/main/agent/runtime/PiTurnExecutor.ts`
  (`Agent`, `AgentEvent`, `AgentState`, message types),
  `src/main/agent/capabilities/agentStreamAbort.ts` (`StreamFn`).
- Type-swap only (10): `src/main/agent/context/TurnDiagnostics.ts`
  (`AgentEvent` for `captureEvent`, `AgentState` for the thinking-level type),
  plus the 9 tool-vocabulary files — `agentSkills.ts`,
  `agentImageGenerationTool.ts`, `agentToolEnvelope.ts` (`AgentToolResult`,
  `AfterToolCallResult`), `agentNodeToolVisibility.ts`, `agentLocalTools.ts`,
  `agentNodeTools.ts`, `agentTools.ts`, `runtime/ToolRuntime.ts`,
  `automations/AutomationTool.ts` (`AgentTool` / `AgentToolResult` /
  `AfterToolCallResult`).

**The executor is already programmed against an interface.**
`PiTurnExecutor.ts:125-131` defines `PiAgentRuntime`
(`state.errorMessage` / `subscribe` / `abort` / `steer` / `prompt`), injected
via `PiTurnExecutorOptions.createAgent` (`:108`); default `new Agent(options)`.
Tests already exploit this seam (`tests/core/agentPiTurnExecutor.test.ts`).
**The kernel implements `PiAgentRuntime`; the executor swaps the default
factory. That is the whole integration.**

**The Agent contract actually used** (single construction site,
`PiTurnExecutor.ts:258`): `initialState { systemPrompt, model, thinkingLevel,
tools, messages }`, `streamFn` (currently the `createAbortSettledStreamFn`
wrapper), `getApiKey`, `onPayload`, `onResponse`, `transformContext`,
`steeringMode: 'all'`, `sessionId` (cache affinity → `prompt_cache_key`),
`maxRetryDelayMs`, `toolExecution: 'parallel'`. NOT passed (verify with grep,
see Dropped-behavior ledger): `convertToLlm`, `beforeToolCall`,
`afterToolCall`, `prepareNextTurn`, `prepareNextTurnWithContext`,
`followUp`/`followUpMode`, `thinkingBudgets`, `transport`, `continue()`,
`reset()`, `images` on `prompt()`.

**Tenon tools DO declare `executionMode: 'sequential'` — widely.** 15
declarations across 6 files as of `79c87380`: `agentSkills.ts`,
`agentImageGenerationTool.ts`, `agentNodeTools.ts` (×4), `agentLocalTools.ts`
(×5), `runtime/ToolRuntime.ts` (×3), `automations/AutomationTool.ts`. The
kernel MUST implement both batch paths and the batch-downgrade rule (BC12).
Derive the authoritative list at build time with
`rg "executionMode: 'sequential'" src/` (A11), do not trust this snapshot.
Sequential batches are the COMMON case, not an edge case — an earlier draft of
this plan claimed only two sequential tools off a truncated grep.

**Not used anywhere in Tenon** (verified `rg`, keep verifying at build time):
`prepareArguments` on tools (implement anyway — 8 lines, part of the tool
contract, BC14), `tool_execution_update` consumers (normalizer and
`TurnDiagnosticsCollector.captureEvent` ignore it; kernel still emits it,
BC15 — parity over minimalism).

**`transformContext` in Tenon** ignores pi's input messages and rebuilds the
provider messages from canonical state via `projectCanonicalProviderContext`
(`PiTurnExecutor.ts:369`), returning the projected `Message[]`.

**Internal-memory Turns run WITHOUT projection.** The memory-consolidation
path (`threadSource === 'memory_consolidation'`) sets
`transformContext = undefined` and installs no overflow recovery
(`PiTurnExecutor.ts:217-219`, `:277` conditional): it speaks the raw in-memory
transcript (`initialState.messages` + accumulated turn messages) and canonical
overflow compaction is not executable there. The kernel MUST support this
mode: both ports are optional (§5), and with `transformContext` absent the
kernel streams its internal transcript as-is (pi `agent-loop.js:179-184`
semantics; the transcript only ever contains provider-legal roles).

**agentStreamAbort semantics to absorb** (`agentStreamAbort.ts`): request vs
stream retry budgets (`canRetryResponses = retrySource &&
isOpenAIResponsesModel(model)`; defaults 4 request / 1 stream, `:41-42`;
`providerMaxRetries` overrides both), 429/5xx + transport-regex classification
(`:458`), exponential delay + jitter capped by `maxRetryDelayMs`,
buffer-before-retry (`shouldBufferBeforeRetryDecision`), abort settling
(partial `AssistantMessage` synthesis, `completedToolCallIds`),
context-overflow recovery (`onContextOverflow` →
`compactContext('providerOverflow', activeAdmissionCursor)` → re-run
`transformContext()` → retry), retry observation (`onProviderRetry` →
`diagnostics.captureProviderRetry` + renderer status).

## Behavioral Contract (normative — the kernel MUST reproduce these)

Each rule cites its source in `pi-agent-core@0.80.6` dist. The golden fixture
(Verification §2) encodes every rule marked ★. A dev agent may not "improve" a
BC rule; deviations are plan changes and go back to the PM.

**Run lifecycle**

- BC1 ★ `prompt()` while a run is active throws
  (`agent.js:220-222`); `abort()` aborts the active run's controller
  (`agent.js:198-200`).
- BC2 ★ Event cascade on a fresh prompt: `agent_start`, `turn_start`, then
  `message_start` + `message_end` for each prompt message
  (`agent-loop.js:48-53`). The normalizer ignores non-assistant messages, but
  diagnostics `captureEvent` receives everything — cadence is observable.
- BC3 ★ If the loop body throws — a genuine exception such as
  `transformContext` throwing or a kernel bug, NEVER a provider failure (those
  are data, BC20) — the run does NOT reject: a failure assistant message
  is synthesized — `stopReason: aborted-if-signal-aborted-else-error`,
  `errorMessage`, empty usage, empty text content — and emitted as the full
  cascade `message_start`, `message_end`, `turn_end(message, [])`,
  `agent_end([failureMessage])` (`agent.js:338-354`). `state.errorMessage` is
  set from the assistant `errorMessage` on `turn_end` (`agent.js:393-397`).
  PiEventNormalizer's `stopReason`/`errorMessage` and the executor's
  failed-turn path depend on exactly this.
- BC4 ★ `agent_end` is always the final event, exactly once per run
  (`agent-loop.js:109,156,171`; `agent.js:353`). Listeners are awaited
  sequentially in subscription order before the run settles
  (`agent.js:406-408`).

**Loop structure**

- BC5 ★ Steering is polled BEFORE the first model call (user may have typed
  while waiting; `agent-loop.js:82`) and again AFTER each turn
  (`agent-loop.js:159`). With `steeringMode: 'all'` a drain returns the whole
  queue in FIFO order (`agent.js:63-68`).
- BC6 ★ Drained steering messages are emitted as `message_start` +
  `message_end` pairs and appended to the transcript BEFORE the next model
  call (`agent-loop.js:95-103`). A steer that arrives DURING a model call is
  therefore never visible to the in-flight call — it lands next iteration.
- BC7 ★ `turn_start` is emitted at every inner-loop iteration after the first
  (`agent-loop.js:88-93`); `turn_end(message, toolResults)` after each
  assistant message + its tool batch (`agent-loop.js:130`).
- BC8 ★ Assistant `stopReason === 'error' | 'aborted'` short-circuits:
  `turn_end(message, [])` then `agent_end`, loop exits
  (`agent-loop.js:107-111`).
- BC9 ★ Loop continues while there are tool calls or pending steering; when
  neither remains, the run ends with `agent_end` (`agent-loop.js:87,161-171`;
  follow-up queue is unused in Tenon — see Dropped ledger).

**Model call**

- BC10 ★ Per call, in order: `transformContext(…)` (Tenon: full canonical
  re-projection), then build `{ systemPrompt, messages, tools }`, then resolve
  the API key FRESH (`getApiKey(provider) || config.apiKey` — expiring OAuth
  tokens; `agent-loop.js:177-198`), then stream.
- BC11 ★ Stream event mapping (`agent-loop.js:199-254`):
  `start` → push partial to transcript + `message_start` (copy of partial);
  `text_*`/`thinking_*`/`toolcall_*` → replace transcript tail +
  `message_update` with `assistantMessageEvent` + message copy;
  `done`/`error` → final from `response.result()`, replace-or-push tail,
  `message_start` first if no `start` ever arrived (non-streamed error), then
  `message_end`. Copies (`{ ...partialMessage }`) are part of the contract —
  subscribers mutate freely.
- BC20 ★ Provider failures are DATA, not exceptions: a failed call settles
  with a terminal `AssistantMessage` (`stopReason: 'error' | 'aborted'`)
  preserving partial content, usage, provider facts, and `errorMessage`
  (`agentStreamAbort.ts` `settleWithTerminalMessage`); the normalizer and
  diagnostics consume that message like any other. The kernel throws only for
  non-provider exceptions (BC3).
- BC21 ★ Completed-tool-call salvage: on a custom-Responses stream-termination
  error where the partial message contains tool calls and EVERY one of them
  finished streaming (`completedToolCallIds`), the terminal message is
  salvaged to `stopReason: 'toolUse'` with the error dropped, and the turn
  proceeds to execute the batch instead of failing
  (`agentStreamAbort.ts` `salvageTerminatedCustomResponsesToolUse`; dedicated
  test at `tests/core/agentStreamAbort.test.ts:625`).
- BC22 ★ Overflow-recovery failure prefixes: when overflow recovery is
  exhausted or nothing was eligible to compact, the terminal message keeps its
  provider facts but its `errorMessage` is prefixed with the exact existing
  wording (`agentStreamAbort.ts:499-508` `contextOverflowFailure`), and
  `stopReason` is forced to `'error'`.

**Tool batches**

- BC12 ★ Batch mode: sequential iff `toolExecution === 'sequential'` OR any
  called tool declares `executionMode: 'sequential'` (`agent-loop.js:287-293`).
  Tenon's skill and image-generation tools do — a batch containing a skill
  invocation must serialize the WHOLE batch.
- BC13 ★ Parallel path (`agent-loop.js:332-376`): for each call in call order —
  emit `tool_execution_start`, then prepare (BC14) SEQUENTIALLY (prepare of
  call N+1 does not start before call N's prepare settles); immediate
  errors finalize inline (`tool_execution_end` immediately); prepared calls
  become async thunks. Then all thunks run concurrently
  (`Promise.all`) — so `tool_execution_end` events may interleave OUT of call
  order — but `toolResult` messages are emitted (as `message_start` +
  `message_end` pairs, `agent-loop.js:541-544`) strictly IN call order
  afterwards. Sequential path: full prepare→execute→finalize per call in
  order; abort breaks between calls (`agent-loop.js:323-325`).
- BC14 ★ Prepare (`agent-loop.js:393-448`): unknown tool → immediate error
  result "Tool ${name} not found"; `prepareArguments` applied if declared;
  `validateToolArguments` (from `pi-ai/compat`); abort re-checked around the
  (unused in Tenon) `beforeToolCall` hook; any throw → immediate error result
  with the thrown message. Tool `execute` throw → error result with the thrown
  message (`agent-loop.js:468-475`). Error results carry
  `content: [{ type: 'text', text }]` and empty `details`
  (`agent-loop.js:513-518`).
- BC15 ★ `tool_execution_update` is emitted for partial results during
  `execute` and stops being accepted once `execute` settles
  (`agent-loop.js:449-478`). No Tenon consumer today; emit anyway.
- BC16 ★ `stopReason === 'length'` with tool calls: every call in the message
  is failed WITHOUT execution (truncated-arguments hazard) with the exact
  error text of `agent-loop.js:263-283`, and the loop CONTINUES (model sees
  the errors and may re-issue).
- BC17 ★ Batch termination: `terminate` only when the batch is non-empty and
  EVERY finalized result has `terminate === true` (`agent-loop.js:377-379`);
  then the inner loop stops requesting another model call.
- BC18 ★ `toolResult` message shape: `role, toolCallId, toolName,
  content (result.content ?? []), details, isError, timestamp`
  (`agent-loop.js:528-540`).

**State reduction** (needed for `PiAgentRuntime.state` and tests)

- BC19 `message_end` appends to `state.messages`; `turn_end` with an assistant
  `errorMessage` sets `state.errorMessage`; `tool_execution_start/end`
  maintain `pendingToolCalls`; `agent_end` clears the streaming message
  (`agent.js:369-401`). The kernel's compat shell needs `errorMessage`
  faithfully; the rest may be maintained minimally but must not diverge where
  tests observe it.

## Design

New directory `src/main/agent/runtime/kernel/`. All types Tenon-owned;
`pi-ai` types (`Model<Api>`, `Context`, `Message`, `AssistantMessage`, usage)
remain the transport vocabulary.

### 1. `kernel/types.ts`

- Re-declare `AgentTool`, `AgentToolResult`, `AfterToolCallResult`, `StreamFn`
  structurally identical to pi-agent-core's (the 10 type-swap files change
  ONLY the import specifier — completion is `rg`-verifiable).
- `KernelEvent`: the exact union in BC2-BC18 — `agent_start`, `turn_start`,
  `message_start`, `message_update` (`assistantMessageEvent` + message copy),
  `message_end`, `turn_end`, `tool_execution_start`, `tool_execution_update`,
  `tool_execution_end`, `agent_end` — field shapes copied from current usage.
  `PiEventNormalizer.handle` and `TurnDiagnosticsCollector.captureEvent`
  change parameter type only.
- `ModelError`: `{ kind: 'contextOverflow' | 'rateLimit' | 'serverError' |
  'transport' | 'badRequest' | 'aborted'; status?: number; message: string }` —
  a **derived classification** of a terminal error `AssistantMessage`
  (`classifyModelFailure`), never a thrown replacement for it. The
  `agentStreamAbort` regexes move into that single string→value mapping site.
- Tenon-owned replacements for every remaining pi-agent-core type the swap
  files need: `AgentState` (TurnDiagnostics' thinking-level type and the
  `Pick<AgentState, 'errorMessage'>` in `PiAgentRuntime`) and
  `KernelAgentOptions` — the explicit constructor options of
  `NativeAgentRuntime` replacing pi's `AgentOptions` (see §5). The dependency
  cannot be deleted while any of these lack a home.
- Vocabulary fronting (containment, not replacement): re-export the `pi-ai`
  types the runtime/context layers speak — `Message`, `AssistantMessage`,
  `AssistantMessageEvent`, `Model<Api>`, `Context`, usage — so
  `kernel/types.ts` is the single import chokepoint for the transport
  vocabulary. Type aliases only; defining Tenon copies with an
  identity-mapping gateway is explicitly rejected until an actual `pi-ai`
  swap is on the table (ceremony, not cleanliness). Routing EXISTING
  context/runtime imports through the chokepoint is a separate mechanical
  fast-track sweep after this PR merges (A11 queue from
  `rg "from '@earendil-works/pi-ai'" src/main/agent/`), NOT part of this PR's
  tripwire surface.

### 2. `kernel/ModelGateway.ts`

```ts
interface ModelGatewayRequest {
  model: Model<Api>;
  context: Context;                 // { systemPrompt, messages, tools }
  options: SimpleStreamOptions;     // apiKey, signal, sessionId, reasoning,
                                    // cacheRetention, timeoutMs, maxRetryDelayMs…
}
interface ModelGateway {
  stream(request: ModelGatewayRequest): AssistantMessageEventStream;
  // Provider failures NEVER throw: the stream always settles with a terminal
  // AssistantMessage (stopReason 'error' | 'aborted' preserves partial
  // content, usage, provider facts, errorMessage) — BC11/BC21 flow.
  // Only non-provider exceptions (bugs, aborted setup) propagate → BC3.
}
classifyModelFailure(message: AssistantMessage): ModelError | null;
  // Derived, typed VIEW of a terminal error message for policy decisions
  // (retryability, overflow recovery). Classification never replaces the
  // message: the normalizer and diagnostics always receive the full terminal
  // AssistantMessage, exactly as today (agentStreamAbort.ts
  // settleWithTerminalMessage preserves content/usage/provider facts — a
  // thrown slim error here would erase them and break Item-stream parity).
```

`PiModelGateway` wraps `piStreamSimple` with `maxRetries: 0` pinned (retry is
the kernel's, permanently), and hosts THREE capture hooks as constructor
options, in this fixed per-attempt order:

1. `onProviderContext(context)` — fires once per attempt BEFORE the transport
   call, feeding `diagnostics.captureProviderContext` (today:
   `configuredStream`, `PiTurnExecutor.ts:246-249`). This ordering is
   load-bearing: `captureProviderRequest` hard-asserts a captured provider
   context and prepared plan (`TurnDiagnostics.ts:128-129`) — a gateway
   without this hook fails every turn at the first payload capture.
2. `onPayload(payload, model)` — payload-profile transform +
   `captureProviderRequest`.
3. `onResponse(response)` — `captureTransportResponse`.

### 3. `kernel/retryPolicy.ts`

Absorbs `agentStreamAbort.ts` verbatim and is the SOLE owner of attempt
hiding — transient retries AND overflow recovery both live here; the kernel
never compacts, re-projects, or retries on its own (it merely threads the
`recoverContextOverflow` port through). One settled stream goes in front of
the normalizer per model call, exactly as the wrapper provides today.

```ts
function streamWithPolicy(input: {
  attempt: (messages: Message[] | null) => AssistantMessageEventStream;
    // null → current projection; non-null → refreshed messages after recovery
  recoverContextOverflow?: () => Promise<Message[] | null>;
    // absent (internal memory) → overflow is terminal immediately
  maxRequestRetries?; maxStreamRetries?; maxRetryDelayMs?; onProviderRetry;
  signal;
}): AssistantMessageEventStream  // settled; attempts hidden; terminal
                                 // message per BC20/BC21/BC22
```

Semantics preserved verbatim: budgets/defaults (4 request, 1 stream;
`providerMaxRetries` overrides both), delay schedule + jitter + cap,
buffer-before-retry, abort settling, completed-tool-call salvage (BC21),
`onProviderRetry` observation. Decisions run on `classifyModelFailure` of the
terminal message. On `contextOverflow`: call `recoverContextOverflow` once,
retry the attempt with the refreshed messages on success; on failure or a
second overflow, settle with the last terminal message whose `errorMessage`
carries the EXACT existing prefix — exhausted:
"Provider context overflow persisted after one canonical compaction retry.",
no-eligible: "Provider rejected the canonical context as too large, but no
eligible context could be compacted." (`agentStreamAbort.ts:499-508`; BC22).
Transient-retry exhaustion settles with the last terminal message unmodified.
`tests/core/agentStreamAbort.test.ts` → `tests/core/kernelRetryPolicy.test.ts`,
assertions unchanged (the suite IS the semantics spec).

### 4. `kernel/kernel.ts` (~250 lines, zero business logic)

Implements BC1-BC22 as the loop. Per iteration: drain steering (BC5/BC6) →
project (`transformContext` when present, else the internal transcript;
BC10) → `streamWithPolicy` (which hides all retry AND overflow-recovery
attempts and settles one terminal message; BC11/BC20/BC21/BC22) → terminal
`stopReason 'error' | 'aborted'` short-circuits (BC8) → tool batch
(BC12-BC18) → `turn_end` → repeat or `agent_end` (BC9). The kernel contains
NO compaction or retry logic of its own. Abort at any await settles per
BC3/BC8 with `stopReason: 'aborted'`.

### 5. `kernel/NativeAgentRuntime.ts`

Implements `PiAgentRuntime` exactly: `state` (BC19 reduction), `subscribe`
(sequential awaited listeners, BC4), `steer` (enqueue; drain per BC5),
`prompt` (BC1/BC2; runs the kernel to completion), `abort`. Constructed with
an explicit Tenon-owned options type — pi's `AgentOptions` has no injection
port for the overflow-recovery closure, so the plan defines one instead of
pretending the wiring is unchanged:

```ts
interface KernelAgentOptions {
  initialState: { systemPrompt; model; thinkingLevel; tools; messages };
  gateway: ModelGateway;                    // PiModelGateway in production;
                                            // tests inject a scripted gateway
                                            // (replaces today's
                                            // PiTurnExecutorOptions.streamSimple
                                            // seam — that option is REMOVED and
                                            // its tests re-target the gateway)
  retryOptions: { maxRequestRetries?; maxStreamRetries?; maxRetryDelayMs?;
                  onProviderRetry };
  transformContext?: () => Promise<Message[]>;   // per-call re-projection;
    // ABSENT for internal-memory Turns, which stream the raw transcript
  recoverContextOverflow?: () => Promise<Message[] | null>;
    // wraps context.compactContext('providerOverflow',
    // activeAdmissionCursor(turn)) + re-projection — the closure that today
    // lives inline in the executor's onContextOverflow (PiTurnExecutor.ts:278);
    // ABSENT for internal-memory Turns (overflow is terminal there)
  getApiKey; onPayload; onResponse; sessionId; providerOptions;
  steeringMode: 'all'; toolExecution: 'parallel';
}
```

### Executor diff (the whole integration)

`PiTurnExecutor.ts`: the single Agent construction site (`:258`) is rewired to
build `NativeAgentRuntime` with `KernelAgentOptions` — same values, explicit
ports: the `createAbortSettledStreamFn` wrapping, the
`{ ...options, ...providerOptions, maxRetries: 0 }` spread, and the inline
`onContextOverflow` closure are deleted (subsumed by gateway / retryPolicy /
`recoverContextOverflow`); `PiTurnExecutorOptions.streamSimple` is removed in
favor of gateway injection; imports move to `kernel/`. **No changes outside
the construction-site rewiring and those deletions.** `ThreadService.ts` and
`codec.ts` are not touched.

### Dropped-behavior ledger (intentional, verified unused)

`followUp`/`getFollowUpMessages` outer loop (`agent-loop.js:161-167`),
`continue()`, `reset()`, `convertToLlm` (Tenon messages are already provider
`Message`s), `beforeToolCall`/`afterToolCall`, `prepareNextTurn*`,
`thinkingBudgets`, `transport`, `prompt(string, images)` normalization.
Each entry: assert unused with `rg` at build time; if a hit appears (rebase
drift), STOP and escalate to the PM — do not implement on your own judgment.

### Dependency removal

`package.json` / `bun.lock`: drop `@earendil-works/pi-agent-core`
(infrastructure files — this PR IS the coordinated change). `pi-ai` stays.

## Tripwires (mechanical deviation guards)

The PR reviewer (main agent) enforces these with commands, not judgment:

- Allowed diff surface: `src/main/agent/runtime/kernel/**` (new),
  `PiTurnExecutor.ts`, `agentStreamAbort.ts` (deleted), the 10 type-swap
  files incl. `context/TurnDiagnostics.ts` (import/type lines only — `git
  diff` on each must touch only imports and type references),
  `package.json`, `bun.lock`, `tests/core/**`, `docs/spec/agent-model-runtime.md`,
  `docs/spec/agent-core.md`. **Any other changed file fails the gate.**
- `git diff origin/main -- src/main/agent/ThreadService.ts src/core/` → empty.
- `rg "@earendil-works/pi-agent-core" src/` → empty (stage 3 exit).
- `rg "maxRetries: 0" src/main/agent/runtime/PiTurnExecutor.ts` → empty
  (the hack must die in the executor; it lives ONLY inside `PiModelGateway`).
- Behavior questions not answered by a BC rule or the ledger: STOP, escalate.
  The answer becomes a plan edit, not an inline decision.

## Verification

1. **Ported suites**: `agentPiTurnExecutor.test.ts` (incl. #444 additions)
   green against the native runtime with zero assertion edits;
   `agentStreamAbort.test.ts` → `kernelRetryPolicy.test.ts` unchanged.
2. **Golden Item-stream parity** (load-bearing): scripted-gateway fixtures
   (canned `AssistantMessageEvent` sequences) covering: text+thinking deltas;
   parallel tool batch (incl. out-of-order `tool_execution_end`, in-order
   `toolResult` messages — BC13); a batch containing the sequential skill tool
   (BC12); `stopReason 'length'` with tool calls (BC16); mid-stream retry;
   overflow → compaction → re-projection; steering during and between calls
   (BC5/BC6); abort mid-stream and mid-batch; loop-body throw (BC3); a
   provider failure settling as a terminal message with partial content and
   usage preserved (BC20); completed-tool-call salvage on a custom-Responses
   termination error (BC21); overflow exhaustion and no-eligible-compaction
   prefixes (BC22); an internal-memory turn (no transformContext, no overflow
   recovery, raw transcript).
   Recorded against `pi-agent-core` BEFORE the swap (committed JSON), asserted
   deep-equal on: emitted `KernelEvent` sequence, normalized `ThreadItem`
   stream, `TurnDiagnosticsCollector` activity list.
3. **Validate the judge** (a judge that cannot fail is not a judge): mutation
   runs that must FAIL the parity fixture before it counts as a gate —
   (a) swap two `tool_execution_start` emissions, (b) emit `toolResult`
   messages in completion order instead of call order, (c) drop the BC3
   failure-message synthesis, (d) run a sequential-tool batch in parallel.
   Implemented as a test that runs the fixture against 4 deliberately broken
   kernel variants and asserts each is caught.
4. **Full gates**: `bun run typecheck`, `test:core`, `test:renderer`,
   `docs:check`, plus every Tripwire command above.
5. **Real-run smoke** (dev userData, cc-switch): mid-turn steering; a
   skill invocation inside a mixed tool batch; `/clear`; forced-overflow
   compaction; confirm Model Interactions renders identically and `cacheRead`
   stays non-trivial across consecutive calls.

## Spec updates (same PR)

- `docs/spec/agent-model-runtime.md`: runtime ownership — the turn loop, retry
  policy, and error taxonomy are Tenon-owned under
  `src/main/agent/runtime/kernel/`; `pi-ai` is transport-only behind
  `ModelGateway`; "the kernel is the only retry owner".
- `docs/spec/agent-core.md`: one line under Runtime Ownership pointing at the
  kernel directory.

## Build order (stages inside the one PR; exit criteria are commands)

1. `kernel/types.ts` + `kernel/ModelGateway.ts` + `kernel/retryPolicy.ts`.
   Exit: `kernelRetryPolicy.test.ts` green; typecheck green.
2. `kernel/kernel.ts` + `kernel/NativeAgentRuntime.ts`; record golden fixtures
   against pi-agent-core FIRST, then implement until parity + judge-mutation
   tests are green. Exit: Verification §2 + §3 green.
3. Swap the executor default; migrate the 10 type-swap imports; delete
   `agentStreamAbort.ts`; drop the dependency; spec updates.
   Exit: Verification §1/§4 green, all Tripwire commands pass, §5 smoke done.

## Risks

- **Event-order divergence** — mitigated by fixtures encoding BC2-BC18 and the
  judge-mutation tests; the cadence is asserted, not eyeballed.
- **Sequential-batch regression** — the skill tool silently executing in
  parallel is the worst failure mode; BC12 has its own fixture and mutation.
- **Steering timing** — BC5/BC6 fixtures cover during-call and between-call
  steers; the #444 `refreshDiagnostics` path covers the tail window.
- **Partial-stream retry UX** — `shouldBufferBeforeRetryDecision` moves
  verbatim with its tests.
- **Rebase drift** — if main moves under the plan (new Agent options, new
  event consumers), the Dropped ledger's `rg` assertions catch it; escalate,
  don't improvise.

## Open questions

None blocking. Deferred by design: (a) `Pi*` renames (later mechanical PR);
(b) gateway middleware chain (redaction / payload profiles as composable
wrappers) once the port exists.

## Checklist

- [ ] Stage 1: types + gateway + retryPolicy; ported retry suite green
- [ ] Stage 2: fixtures recorded from pi-agent-core; kernel + runtime reach
      parity; judge-mutation tests green
- [ ] Stage 3: executor swap, 10 import migrations, delete agentStreamAbort,
      drop dependency, spec updates
- [ ] All Tripwire commands pass; `typecheck` / `test:core` / `test:renderer`
      / `docs:check` green
- [ ] Real-run smoke on cc-switch (steering, skill-in-batch, compaction,
      cache-hit observation)
