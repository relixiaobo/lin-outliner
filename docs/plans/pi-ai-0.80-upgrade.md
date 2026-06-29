# pi-ai / pi-agent-core 0.78 -> 0.80.2 upgrade

We pin `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` at exact
`0.78.0` in `package.json`. The target is exact `0.80.2`. The upgrade brings
provider/model metadata fixes, streaming robustness fixes, vulnerable dependency
bumps, and the 0.80 API split that moves the old global runtime API behind a
legacy compatibility entrypoint.

This is shape **(a): one complete feature in one PR**. The PR upgrades both
packages and migrates Tenon's product code to pi-ai's 0.80 `Models` API instead
of adopting the temporary `/compat` bridge.

## Goal

Upgrade both pi packages to `0.80.2` and use pi-ai in the clean 0.80 shape:
`builtinModels()` for the full built-in provider collection, a Tenon-backed
`CredentialStore` over `agent-secrets.json`, and `Models.streamSimple()` /
`Models.completeSimple()` for runtime calls.

The app must continue to support the current Tenon settings model:

- full built-in provider picker;
- existing plaintext `agent-secrets.json` credential file with chmod 600;
- current OAuth login UI/orchestration;
- custom OpenAI-compatible provider connections with arbitrary `providerId` +
  `baseUrl`.

## Non-goals

- No renderer protocol or `src/core` type change.
- No rewrite of the OAuth sign-in UI. Login still uses the existing
  `@earendil-works/pi-ai/oauth` provider lookup; request-time auth and token
  refresh move to `Models.getAuth()` through the credential store.
- No new migration/back-compat reader. The existing on-disk credential shape
  already matches pi 0.80's `api_key` / `oauth` discriminator.
- No per-provider bundle slimming. We still need the whole built-in catalog, so
  `@earendil-works/pi-ai/providers/all` is the right explicit entrypoint.

## Design

### Composition Root

Add a main-process `piModels` adapter that owns pi integration:

- create a singleton `builtinModels({ credentials })` collection;
- expose catalog helpers (`piProviders`, `piModelsForProvider`, `piFindModel`);
- expose runtime helpers (`piStreamSimple`, `piCompleteSimple`,
  `piResolveAuthApiKey`);
- adapt Tenon's secret file to pi's `CredentialStore` contract;
- register custom OpenAI-compatible provider connections with `createProvider()`
  and `openAICompletionsApi()` when a Tenon connection has a custom `baseUrl`.

Production code imports from this adapter, not from
`@earendil-works/pi-ai/compat`.

### Credential Store

`agent-secrets.json` remains the single durable credential store:

```ts
type ApiKeyCredential = { type: 'api_key'; key: string };
type OAuthStoredCredential = { type: 'oauth' } & OAuthCredentials;
```

The adapter implements pi's `CredentialStore` as:

- `read(providerId)` -> read and normalize one provider credential;
- `modify(providerId, fn)` -> serialized read/modify/write using the existing
  JSON file lock and chmod 600 options;
- `delete(providerId)` -> remove the provider credential.

OAuth refresh now happens inside pi `Models.getAuth()` / request dispatch, under
`CredentialStore.modify`, so concurrent refreshes serialize through Tenon's
existing file lock. API-key writes and OAuth login/logout still use the current
settings commands and write the same file shape.

### Provider Settings

Replace old global catalog/env helpers with `Models` reads:

- provider list: `models.getProviders().map(provider => provider.id)`;
- provider models: `models.getModels(providerId)`;
- auth kind: inspect the provider's `auth.oauth` plus the managed ambient ids;
- ambient credential status: call `models.getAuth(firstProviderModel)` only when
  no stored credential exists, and render the result as `hasEnvApiKey` /
  `auth.credentialed` for compatibility with the current renderer contract.

`envKeyNames` stays empty for now because pi 0.80 does not expose env-var names
through the `Models` API. The renderer currently uses credentialed state, not the
specific env key labels.

### Runtime Calls

Replace product runtime calls to the old global API with adapter calls:

- `streamSimple` -> `piStreamSimple`;
- `completeSimple` -> `piCompleteSimple`;
- `getModels` / `getProviders` lookups -> adapter catalog helpers.

`pi-agent-core` 0.80.2 still imports `/compat` internally for its own default,
but Tenon passes an explicit `streamFn`, so Tenon product runtime dispatch goes
through `Models.streamSimple()`.

The existing `getApiKey` hook remains only for explicit request overrides
(`providerConfig.apiKey` / test `providerApiKeyLoader`) required by
`pi-agent-core`'s API shape. Stored credentials, ambient env/managed auth, OAuth
refresh, provider-specific headers, provider env, and auth-provided `baseUrl`
stay inside pi `Models.applyAuth()` at request time. Tenon does not flatten
non-API-key auth into an `apiKey` string or sentinel value.

### Custom OpenAI-Compatible Providers

A Tenon provider row with `baseUrl` can use an arbitrary `providerId`, so it is
not always present in the built-in catalog. The adapter handles this by
registering a provider on demand:

- provider id: an internal `tenon-custom:<providerId>` so custom endpoints never
  replace a built-in catalog provider with the same id;
- provider name / renderer-facing events: Tenon's `providerId`;
- base URL: Tenon's `baseUrl`;
- auth: explicit request key override, otherwise local endpoints
  (`localhost`, loopback, `*.localhost`) receive an inert client key before any
  stored/ambient provider key is considered, otherwise stored API key or request
  auth inherited from the external provider's pi auth (without inheriting that
  provider's default `baseUrl`); keyless auth is accepted only for local
  endpoints because the OpenAI SDK requires an `apiKey` option even when the
  endpoint does not validate it;
- API implementation: `openAICompletionsApi()`;
- model: the selected/probed OpenAI-compatible model id. When the id is also a
  known catalog model, the synthetic OpenAI-compatible model keeps the catalog's
  neutral sizing/capability metadata (`contextWindow`, `maxTokens`, `reasoning`,
  thinking map, cost/input) while switching provider/API/base URL for dispatch;
  provider-specific dispatch knobs such as headers/compat stay tied to the
  custom endpoint's provider/API/base URL instead of being copied from the
  catalog model.

This keeps existing custom endpoint behavior while routing requests through the
new pi provider collection. It also keeps any configured custom `baseUrl` on Chat
Completions-compatible dispatch, even when the model id exists in the built-in
catalog, instead of accidentally using a built-in provider implementation.

### Tests

Update tests to exercise the new seams:

- model-ranking live catalog reads use `getBuiltinModels()` /
  `getBuiltinProviders()` from `providers/all`, not `/compat`;
- credential tests override the `anthropic` provider in the local `Models`
  collection with a fake OAuth auth object, verifying `CredentialStore.modify`
  refresh persistence rather than the old `getOAuthApiKey` helper;
- custom-provider tests cover internal provider id isolation, inherited auth, and
  runtime event provider-id normalization;
- provider reconcile tests keep verifying durable cleanup rules and managed
  provider exemptions.

## Risks

- **Credential behavior changes from old helper to `Models.getAuth()`.** Covered by
  targeted credential tests for stored keys, OAuth refresh persistence,
  env/managed fallback, and failure-to-undefined behavior.
- **Custom provider registration.** The migration must preserve arbitrary
  OpenAI-compatible endpoints; covered through the adapter design and connection
  probing path.
- **Transitive SDK bumps.** `app:build` must run because provider SDKs are bundled
  into the main process.
- **E2E drift.** Existing E2E suites may have unrelated renderer/mock drift; record
  exact failures rather than claiming full green if they remain.

## Verification

Required before marking the PR ready:

- `bun run typecheck`
- `bun run test:core`
- `bun run test:renderer`
- `bun run docs:check`
- `bun run app:build`
- focused E2E for agent settings/OAuth/provider runtime where applicable
- full `bun run test:e2e`; if it fails, document exact failures and classify
  whether they are caused by this migration

## Collision check

This PR touches `package.json` and `bun.lock` (infrastructure-ownership files),
plus main-process agent provider/runtime files and targeted tests. Coordinate the
package bump as the branch's claim. No protocol/`src/core` change is planned.

## Checklist

- [x] Bump both pi packages to `0.80.2` and update `bun.lock`.
- [x] Add a Tenon-owned pi `Models` adapter.
- [x] Wire `agent-secrets.json` as a pi `CredentialStore`.
- [x] Replace product `/compat` imports with adapter / `providers/all` usage.
- [x] Preserve custom OpenAI-compatible provider support.
- [x] Update credential and live-catalog tests.
- [ ] Run full verification and update the PR body with results.
