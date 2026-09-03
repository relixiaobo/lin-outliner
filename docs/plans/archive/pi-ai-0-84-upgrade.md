# Pi AI 0.84 Upgrade

**Shape:** (a) ONE complete feature in one PR.

## Goal

Upgrade `@earendil-works/pi-ai` from `0.83.0` to `0.84.4` so Tenon gains the
current provider transports, model catalogs, authentication fixes, and
generation-safe dynamic-catalog publication without weakening Tenon's ownership
of Turns, retries, tool execution, or durable history.

## Non-goals

- Do not adopt `pi-agent-core`, deferred provider execution, provider telemetry,
  or upstream turn-loop behavior.
- Do not change Tenon's provider retry budgets, context-overflow recovery,
  portable tool identities, or persisted Turn protocol.
- Do not add migrations for cached dynamic catalogs; the existing validated
  `ModelsStoreEntry` format remains readable.
- Do not redesign provider settings. New built-in providers use the existing
  catalog, credential, naming, and neutral-avatar fallbacks.

## Design

### Dependency And Transport Boundary

- Pin `@earendil-works/pi-ai` to `0.84.4` and refresh `bun.lock`. Accept its
  `openai` SDK update, telemetry contract dependency, native Mistral transport,
  and generated provider/model catalog changes as one atomic dependency update.
- Keep `ModelGateway` as the only language-model transport port. Tenon continues
  to own retries and passes `maxRetries: 0` into pi-ai; new deferred and telemetry
  APIs remain unused.
- Preserve the existing real-adapter regression tests for Anthropic tool
  serialization, OpenAI Responses payload compatibility, portable tool-call
  identities, and retry classification.

### Dynamic Model Catalogs

- Replace direct calls to `Provider.refreshModels()` with provider-scoped
  `Models.refresh({ providers: [providerId] })`. This lets pi-ai own refresh
  generations, cancellation, stored snapshots, and atomic publication while
  retaining Tenon's one-provider refresh behavior.
- Convert a returned provider error back into a rejection so explicit refresh
  still reports failure and best-effort credential warming can still catch and
  ignore it at its existing boundary.
- Build unsaved-credential catalog probes with an isolated in-memory credential
  collection and model store. Refresh only the target provider, propagate its
  error, and return its isolated models so a connection test cannot mutate the
  live catalog or durable cache.
- Add regression coverage for superseding an older provider refresh: only the
  newest generation may publish in-memory and persisted catalog state.

### Terminal Response Diagnostics

- Treat pi-ai's `pending` and new `deferred` stop reasons as non-terminal states
  that are not admitted into inspection-only Turn diagnostics. Do not widen the
  durable provider-response codec because Tenon does not request deferred
  execution.
- Add a diagnostic regression test proving an unexpected deferred message-end is
  skipped without failing the Turn or changing the terminal protocol.

### Provider Presentation And Catalog Guards

- Add explicit display names and credential-documentation links for the new
  Baseten and Qwen Token Plan Individual providers while retaining the existing
  neutral monogram fallback when no vendored icon exists.
- Keep live catalog guards authoritative: every OAuth provider remains covered,
  declared model product lines remain complete, and the newest-model ordering
  test continues to pass against the upgraded catalog.

### Specification

- Update `docs/spec/agent-model-runtime.md` to state that provider-scoped refresh
  and isolated connection probes go through collection-owned, generation-safe
  catalog publication, and that unsupported non-terminal provider responses are
  omitted from inspection-only diagnostics.

## Risks

- Generated catalog churn can remove configured model IDs. Tenon's existing
  selection fallback remains the recovery path; catalog/ranking tests catch
  unknown flagship product lines and default-order regressions.
- A collection-wide refresh would recreate the discriminator bug recorded in
  `docs/lessons.md`. The implementation must always pass exactly one provider id.
- Swallowing `Models.refresh()` errors would make explicit refresh falsely
  succeed. The target provider's returned error must be rethrown.
- Persisting probe results would let an unsaved credential alter live settings.
  The probe collection and stores must remain isolated.

## Open questions

None. The PM ratified the upgrade direction and provider/catalog exposure on
2026-09-03.

## Verification

- `bun run typecheck`
- `bun run test:core`
- `bun run test:renderer`
- `bun run docs:check`
- `git diff --check`
- Targeted tests for provider credentials/catalogs, Turn diagnostics, real
  Anthropic/OpenAI/Google serializers, retry policy, OAuth coverage, and model
  ranking.
