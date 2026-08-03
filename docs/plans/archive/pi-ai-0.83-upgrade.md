# pi-ai 0.83 Upgrade

## Goal

Upgrade the only pi runtime package Tenon currently consumes,
`@earendil-works/pi-ai`, from `0.80.6` to `0.83.0`. Preserve Tenon's native
turn kernel, provider connection model, custom OpenAI-compatible endpoints,
CC Switch routing, credential storage, OAuth UI, image generation, and durable
diagnostics while adopting the current pi-ai model catalog and transport fixes.

This is one complete feature in one PR. It does not add `pi-agent-core` or
restore any retired pi runtime layer.

## Approach

### Provider-owned authentication

- Replace the removed global OAuth registry with `Models.login()` and
  `Models.logout()` through the existing `piModels` composition root.
- Adapt Tenon's renderer event protocol to pi-ai's provider-neutral
  `AuthInteraction` without exposing credentials to the renderer. Preserve
  flow-level cancellation, per-prompt cancellation, device codes, manual-code
  fallback, selection prompts, and progress/auth URL events.
- Extend Tenon's persistent `CredentialStore` adapter with non-secret `list()`
  enumeration. Keep the existing serialized file-lock semantics and the rule
  that returning `undefined` from `modify()` leaves the credential unchanged.
- Keep OAuth-primary presentation for OAuth-capable providers. Providers whose
  current pi-ai definition also accepts a pasteable API key retain the existing
  "use an API key instead" path; GitHub Copilot remains OAuth-only in Tenon's UI
  because its alternate token is an ambient integration token, not a normal
  user-facing API key.

### Custom and local providers

- Migrate custom provider auth resolvers to the new provider-scoped callback
  contract. Endpoint-local decisions use the provider configuration captured
  by the provider factory rather than the removed per-request `model` input.
- Resolve CC Switch's model-specific source credential before dispatch and pass
  it as Tenon's explicit request override. The pi provider itself remains
  provider-scoped and never needs to inspect a model during auth resolution.
- Preserve custom provider ID remapping, base URLs, model metadata, and local
  keyless endpoint behavior.

### Catalogs and streaming

- Adopt the 0.83 generated language and OpenRouter image catalogs, including
  current reasoning metadata and removed model IDs. Tenon does not reintroduce
  removed upstream catalog entries.
- Wire pi-ai's dynamic text-model refresh into the existing provider refresh
  command. A dynamic provider such as Radius must expose a refresh action and
  update its model choices after login or explicit refresh; it must not appear
  as permanently empty and unusable.
- Treat pi-ai's `pending` stop reason as streaming-only. A non-terminal partial
  must never enter Tenon's durable terminal-response union; diagnostics skip an
  impossible pending `message_end` rather than failing a completed turn.
- Continue disabling pi-ai request retries at `ModelGateway`; Tenon's native
  retry policy remains the sole retry owner.

### Dependency ownership and documentation

- Pin `typebox` directly because Tenon imports `Static` and `TSchema` from it;
  do not rely on pi-ai's transitive dependency.
- Update the runtime and provider-settings specs for provider-owned auth,
  dynamic catalog refresh, and streaming-only `pending` state.
- Correct README wording that still claims the application uses
  `pi-agent-core`.

## Files

Expected implementation surface:

- `package.json`, `bun.lock`, `README.md`
- `src/main/piModels.ts`, `src/main/piImageModels.ts`
- `src/main/agent/capabilities/agentOAuth.ts`
- `src/main/agent/capabilities/agentOAuthManager.ts`
- `src/main/agent/capabilities/agentSettings.ts`
- `src/main/agent/context/TurnDiagnostics.ts`
- provider settings catalog/model helpers and localized OAuth copy
- focused core, renderer, and E2E tests
- `docs/spec/agent-model-runtime.md`
- `docs/spec/design-system/surfaces.md`

`src/core/types.ts` needs documentation-only updates: the existing OAuth event
union and OAuth-primary `authKind` remain sufficient. `docs/TASKS.md` and
`CHANGELOG.md` remain main-agent-owned.

## Risks

- The authentication rewrite can silently break token refresh or cancellation
  even after typechecking; credential and OAuth manager tests must cover both.
- CC Switch currently derives credentials from the selected model. Moving that
  derivation outside pi-ai's provider resolver must preserve every request,
  connection test, and custom endpoint path.
- New dual-mode OAuth providers could hide an already stored API key unless the
  fallback presentation is updated with the package catalog.
- Radius has no static models. Login and explicit refresh must populate its
  runtime catalog without introducing an unbounded settings-read network call.
- Removed model IDs may invalidate pre-release saved selections; existing model
  validation/fallback behavior remains authoritative and needs regression
  coverage against the new catalog.
- TypeBox 1.3 removes deprecated APIs. Tenon uses only retained type exports,
  but argument validation needs focused nullable-array coverage.

## Collision Result

The task board has no in-flight pi-ai, provider-auth, OAuth, or model-catalog
claim. The initial check found `unified-command-surface`, whose declared area
does not overlap this plan, plus an unclaimed
`agent-canonical-tool-call-history` branch touching `TurnDiagnostics.ts`.

The final open-PR file-scope check found two shared-file overlaps. Draft PR #483
now claims `TurnDiagnostics.ts`, its focused test, and
`docs/spec/agent-model-runtime.md`; this branch keeps the diagnostics change to
the new streaming-only `pending` guard. PR #486 touches the English and Chinese
message catalogs for unrelated Thread command keys. Neither overlap shares an
edited symbol or copy key, but the main integration agent must sequence and
rebase whichever PR lands second. Open PRs #480 and #485 do not overlap this
plan, and no other PR claims the dependency files, provider auth, OAuth, or model
catalog implementation.

## Verification

- `bun run typecheck`
- focused provider credentials, OAuth, model catalog/ranking, image generation,
  turn diagnostics, native kernel, and retry-policy tests
- `bun run test:core`
- `bun run test:renderer`
- `bun run docs:check`
- `bun run app:build`
- focused provider/OAuth settings E2E
- `bun run test:e2e`, classified against the repository's current CI baseline

Outcome on 2026-08-03:

- `bun run typecheck`, `bun run test:core` (1716 pass, 6 skip),
  `bun run test:renderer`, and `bun run app:build` passed.
- Focused provider/OAuth E2E passed 37/37.
- On the final head after syncing `origin/main`, full E2E passed 551/552. The
  single failure was an unrelated concurrency-sensitive trailing-input test; it
  passed three consecutive focused reruns with one worker (3/3).

## Checklist

- [x] Claim the scope with a Draft PR.
- [x] Upgrade pi-ai and pin TypeBox directly.
- [x] Migrate OAuth and credential storage contracts.
- [x] Preserve custom endpoint and CC Switch auth behavior.
- [x] Wire dynamic text catalogs and new OAuth-capable providers.
- [x] Keep `pending` out of durable terminal diagnostics.
- [x] Update focused tests and current specs.
- [x] Run and record the full verification matrix.
