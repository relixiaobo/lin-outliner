# Responses Tool Contract Hardening

**Shape:** (a) ONE complete feature in one implementation PR. The wire contract,
exact argument admission, repeated-failure containment, guards, tests, and current
spec updates ship together because each layer alone leaves another path to the same
dead Turn.

## Goal

Make function-tool behavior deterministic across OpenAI Responses endpoints and
relays. A provider must see the schema Tenon authored, the kernel must either admit
the exact JSON value the model supplied (after an explicit tool-owned preparation)
or reject it, and a model that repeats the same rejected call must not consume the
rest of the Turn indefinitely.

This is systemic rather than a `node_create` patch:

| Surface | Exposure |
| --- | --- |
| Function tools on a Responses request | A missing `strict` can let an endpoint or relay reinterpret optional fields; schemas with optional members show the failure first. |
| Every `AgentTool` entering the native kernel | The shared dependency validator currently permits generic scalar coercion, so built-in, dynamic, extension, and MCP-backed function tools can receive values with different JSON semantics from the model output. |
| Every deterministically rejected tool call | Correction evidence exists, but there is no Turn-local breaker when the model repeats the same rejected call. |
| Responses built-ins and custom/grammar tools | They do not use the function-tool `strict` field and must remain byte-for-byte unchanged by the wire fix. |
| Non-Responses providers | They are not affected by the Responses `strict` ambiguity, but still benefit from exact kernel admission and loop containment. |

The design follows two verified precedents:

- OpenAI's [function-calling strict-mode contract](https://developers.openai.com/api/docs/guides/function-calling#strict-mode): strict structured outputs require a stricter schema shape, while `strict: false` preserves ordinary optional-property semantics. Tenon must not leave that choice to an intermediary.
- OpenAI Codex at commit `070a26a1f00817931a17e2cdf8fbe03a2a0ed128`: `ResponsesApiTool.strict` is a required `bool`, `tool_definition_to_responses_api_tool` sets it to `false`, and `create_tools_json_for_responses_api_includes_top_level_name` locks the serialized field. Handler `parse_arguments<T>` uses typed `serde_json` decoding and returns `FunctionCallError::RespondToModel` on a mismatch instead of generically converting scalar values. No universal repeated-schema-failure breaker appears in the inspected router/handler path, so Tenon adds that host-level containment for the observed loop class.

## Non-goals

- Do not migrate Tenon's function tools to `strict: true`. That requires every
  property to be required and optional values to be represented with explicit
  nullable unions; it is a separate schema-design program.
- Do not redesign `node_create` as a discriminated union or split it into more
  tools. The fix must protect the existing tool and every peer contract.
- Do not heuristically delete or rewrite `null`, `""`, `0`, `false`, numeric
  strings, unknown fields, or array members. Those values are distinct protocol
  facts.
- Do not use `model.compat.supportsStrictMode = true` to force serialization. That
  flag claims provider constrained-sampling capability and can select semantics the
  relay does not implement; the required `strict: false` default is a wire-contract
  decision instead.
- Do not change Responses built-in, custom, or grammar tool payloads, permission
  policy, capability evaluation, tool result envelopes, or renderer presentation.
- Do not treat network, rate-limit, provider-stream, persistence, permission, or
  tool-execution failures as deterministic schema failures.
- Do not claim Tenon can repair a relay that ignores an explicit `strict: false` or
  mutates `parameters`. The smoke test detects that protocol violation; operations
  must then repair or replace the relay.
- Do not change `src/core/commands.ts` or `src/core/types.ts`, and do not add a
  dependency or persistence migration.

## Design

### Decision summary

- Every function tool in a Responses-family wire payload carries an explicit
  boolean `strict`; absent means Tenon's current default, `false`.
- `AgentTool.prepareArguments` is the sole generic admission path allowed to
  normalize model arguments. The shared validator only checks the resulting JSON;
  it never converts it.
- The kernel fingerprints deterministic admission failures. The second identical
  failure quarantines that tool for the rest of the Turn, and a Turn-wide ceiling
  closes tool exposure before one final provider response.
- Static schemas are guarded in the test suite. Runtime-provided schemas are
  validated at their registration/exposure boundary, where one bad contribution is
  omitted and diagnosed rather than killing an unrelated user Turn.

### Responses wire contract

Extend the payload policy in `applyCustomOpenAIResponsesPayloadProfile` into one
explicit Responses-family function-tool invariant:

1. Walk only top-level tool records whose `type` is `function`.
2. Preserve an explicit boolean `strict` value.
3. Add `strict: false` when the field is absent. Do not rewrite `parameters`,
   `required`, `additionalProperties`, descriptions, names, ordering, or deferred
   loading metadata.
4. Treat a present non-boolean value as a local payload-construction defect and
   stop before network I/O with a bounded diagnostic naming the tool. Never send an
   ambiguous contract.
5. Leave built-in tool records such as native web search, plus custom/grammar tools,
   unchanged.

The invariant applies wherever Tenon's payload hook receives an
`openai-responses`, `openai-codex-responses`, or `azure-openai-responses` request.
The custom relay path needs the mutation because `pi-ai` deliberately omits
`strict` when model compatibility says strict mode is unsupported. Official paths
normally already serialize a boolean; the same invariant becomes a regression
assertion rather than a semantic change.

A transport-level test must use `pi-ai` with a fake `fetch`, capture the actual POST
body, and prove that every function tool carries `strict: false` by default while
its original schema is structurally unchanged. Pure tests of the payload helper stay
as focused edge coverage but are not sufficient evidence for the emitted request.

### Exact argument admission

Replace the kernel's use of dependency-owned `validateToolArguments` with a
Tenon-owned exact validator. The ordered boundary remains:

```text
raw provider tool call
  -> resolve canonical identity
  -> run that tool's prepareArguments, if present
  -> validate the prepared JSON without conversion
  -> freeze the same value for canonical history and execution
  -> evaluate capability policy
  -> execute
```

The validator compiles/checks the existing TypeBox/JSON Schema directly. It must
not call `Value.Convert` or a fallback coercion helper. Therefore:

- `null` is valid only where the schema explicitly admits `null`;
- strings, numbers, integers, and booleans never convert into one another;
- `""`, `0`, and `false` remain valid values when the schema admits them;
- arrays retain member order, types, and cardinality;
- unknown fields remain present for validation and are rejected when
  `additionalProperties: false`; and
- the prepared value that passes validation is the value supplied to redaction,
  canonical admission persistence, capability evaluation, and execution.

`prepareArguments` may perform a tool-specific, reviewable normalization needed by
that tool's public contract. It runs once, before validation, and may not inject host
metadata. A preparation failure is ordinary `invalidArguments` evidence. No later
layer may mutate the admitted value.

Schema compilation is also a lifecycle guard. The built-in catalog has a test that
compiles every exposed schema. Dynamic, extension, and MCP-backed function schemas
are checked before entering the Turn registry; an invalid schema makes only that
contribution unavailable and records a bounded diagnostic. This keeps schema
corruption out of the kernel without violating A12 by terminating unrelated work.

### Turn-local repeated-failure containment

Add a Turn-local admission-failure guard owned by `runKernel`; it is recreated for
each user Turn and is never persisted as conversation state. For each deterministic
rejection it hashes, but does not persist, this stable fingerprint:

```text
canonical identity (or unresolved provider name)
  + admission schema digest (when resolved)
  + stable JSON of the pre-redaction attempted arguments
  + rejection reason
```

Provider call ID is deliberately excluded. Secret-like argument values remain only
in the in-memory hash input; diagnostics and evidence continue to use the existing
redacted/bounded forms.

The state machine is:

1. The first fingerprint occurrence emits and persists the existing correction
   evidence. The tool remains exposed so the model can derive a genuinely new call.
2. The second occurrence of the same resolved-tool fingerprint emits the same honest
   rejection evidence, then quarantines that canonical tool for the remainder of the
   Turn.
3. The next provider request filters the quarantined tool from `context.tools` while
   leaving all other tools available. This gives the model one explicit chance to use
   another capability or explain the block.
4. Different arguments, a changed schema digest, or a different rejection reason do
   not collide with the earlier fingerprint.
5. `invalidArguments` and `truncatedArguments` participate in per-tool quarantine.
   `unresolvedTool` has no real tool to quarantine, but contributes to the Turn-wide
   ceiling.
6. A fixed ceiling of eight deterministic admission failures closes all model-tool
   exposure for the remainder of the Turn. The kernel makes one final tool-free
   provider request; if the provider nevertheless emits a tool call, it records
   bounded rejection evidence and ends the Turn without scheduling another provider
   request.

Execution exceptions, transient provider failures, persistence failures, capability
blocks, permission denials, and cancellations neither increment fingerprints nor
quarantine tools. Their retry and degradation semantics remain owned by their current
boundaries.

### Verification and acceptance

- `openAIResponsesCompat` unit coverage checks absent/false/true/invalid `strict`,
  mixed function/built-in/custom tools, schema identity, official endpoints, and the
  custom relay profile.
- A fake-fetch integration test captures a real Responses POST body and asserts every
  emitted function contract has an explicit boolean `strict` without schema rewriting.
- Exact-validator tests cover nullable unions, optional values, strings, numbers,
  integers, booleans, arrays, nested objects, and unknown fields. They prove both
  rejection of wrong JSON types and preservation of valid falsy values.
- Kernel tests cover first-failure correction, identical second-failure quarantine,
  different-argument non-collision, quarantine reset on the next Turn, the eight-error
  ceiling, and the final tool-free response. Execution and transient provider errors
  must not trip the guard.
- Registry tests compile all built-in schemas and prove one malformed dynamic or
  extension/MCP contribution is omitted without suppressing valid siblings.
- Existing canonical-history tests continue to prove that rejected evidence is not
  replayed as a tool call and admitted execution/history receive the same exact value.
- Production-relay smoke exercises valid and invalid calls for `node_create`,
  `web_search`, and `bash`, captures the outbound tool definitions, and confirms an
  invalid call corrects or quarantines without a dead Turn. Any observed mutation of
  explicit `strict: false` or `parameters` is a relay failure, not an application
  workaround target.
- Required gate: `bun run typecheck`, `bun run test:core`, and
  `bun run docs:check`.

### Implementation surface

- `src/main/openAIResponsesCompat.ts` — Responses-family function-tool wire invariant.
- `src/main/agent/runtime/kernel/kernel.ts` — exact admission integration and
  Turn-local failure/quarantine state.
- `src/main/agent/runtime/kernel/` — a small exact-validation helper if separating it
  keeps the kernel legible.
- `src/main/agent/runtime/ToolRuntime.ts` — runtime schema admission for dynamic,
  extension, and MCP-backed contributions.
- `tests/core/openAIResponsesCompat.test.ts` — payload and real-request wire tests.
- `tests/core/nativeTurnKernel.test.ts` — exact values and loop-containment behavior.
- Existing/new focused schema-registry tests under `tests/core/` — catalog compilation
  and invalid runtime contribution degradation.
- `docs/spec/agent-tool-design.md` and `docs/spec/agent-model-runtime.md` — current wire,
  exact-admission, and Turn-containment contracts.

No protocol/shared file, dependency, renderer file, `docs/TASKS.md`, or
`CHANGELOG.md` is in the dev implementation scope.

### Risks and containment

- Removing coercion can expose model/provider defects that were previously hidden.
  That is intentional; correction evidence plus quarantine bounds the user impact,
  while exact tests distinguish a real contract mismatch from a valid optional value.
- A fingerprint that is too broad could hide a tool after a materially different
  call. Including identity, schema digest, stable arguments, and reason prevents that
  collision; tests lock each dimension.
- Filtering tools changes only future requests in the active Turn. Canonical history,
  audit Items, configuration, and the next Turn's catalog remain unchanged.
- The payload hook must not become a generic schema rewriter. Tests compare the full
  schema and non-function records before and after the policy.

### Collision result

The collision self-check on 2026-08-11 found one open significant claim, PR #525
(`agent-streaming-delta-pipeline`). Its scope is streaming persistence/performance and
does not overlap this plan's files or behavior. The earlier Responses resilience PR
#520 is merged and forms the current payload-profile baseline. `docs/TASKS.md` has no
existing item for this plan; main owns adding the board entry if it ratifies the plan.

## Open questions

- **Turn-wide ceiling:** ratify eight deterministic failures. It is high enough for a
  mixed batch with unrelated corrections but finite even when every attempted argument
  differs; the second-identical-call rule handles the common loop earlier.
- **Responses-family scope:** ratify the cross-family invariant above. Applying the
  absent-to-false rule only to the currently failing relay would leave the same
  ambiguity on another Responses adapter; preserving explicit booleans keeps supported
  strict tools intact.

## Implementation checklist

- [ ] Enforce and transport-test the explicit Responses function-tool `strict` field.
- [ ] Add exact, non-coercing argument validation and schema lifecycle guards.
- [ ] Add Turn-local fingerprints, per-tool quarantine, and the total failure ceiling.
- [ ] Add focused regression tests and production-relay smoke evidence.
- [ ] Fold the ratified design into the two agent specs in the implementation PR.
