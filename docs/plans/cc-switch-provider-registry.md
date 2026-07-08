# CC Switch Provider Registry

## Goal

Replace Tenon's current CC Switch integration with a registry-backed integration
that treats CC Switch as the external provider manager. Tenon should discover
CC Switch-managed providers from `~/.cc-switch/cc-switch.db`, expose the providers
it can run safely, and give clear route-specific diagnostics when a provider
requires CC Switch Local Proxy or is not supported yet.

This is **shape (a): one complete feature in one PR**. The feature is complete
when Tenon no longer reads Codex's generated `~/.codex/config.toml` /
`~/.codex/auth.json` as the normal CC Switch path, and the settings/runtime UI is
driven by CC Switch's provider registry.

## Non-goals

- Do not write to the CC Switch database, switch CC Switch's active provider, or
  start/stop CC Switch Local Proxy.
- Do not fall back to Codex generated files when the CC Switch database is
  missing, unreadable, or unsupported.
- Do not reimplement CC Switch's protocol conversion layer for Codex
  Chat-Completions routing, Claude OpenAI-compatible routing, Gemini Native
  routing, failover, request rectification, or managed-account proxying.
- Do not store, copy, reveal, or migrate CC Switch-managed keys into Tenon's
  `agent-secrets.json`.
- Do not change Tenon's first-party OpenAI, OpenAI Codex, Anthropic, Google, or
  OpenRouter providers.

## Source Facts

- CC Switch describes `~/.cc-switch/cc-switch.db` as its SQLite source of truth
  for providers, MCP, prompts, and skills, with `settings.json` reserved for
  device-level preferences.
- The observed CC Switch schema stores provider rows in `providers`, endpoint
  rows in `provider_endpoints`, and per-app proxy settings in `proxy_config`.
- A local probe on 2026-07-08 confirmed that reading only
  `~/.cc-switch/cc-switch.db` can recover the active Codex provider's endpoint,
  `apiFormat`, model, and API key shape, and can successfully call the model via
  both non-streaming and streaming OpenAI Responses requests.
- CC Switch marks Codex `openai_chat` providers as requiring local routing so
  its proxy can convert Codex Responses requests into Chat Completions and rebuild
  Responses-shaped output.
- In the current Tenon implementation, CC Switch support is a Codex mirror:
  main reads `~/.codex/config.toml` and `~/.codex/auth.json`, extracts the active
  Codex `base_url`, `wire_api`, model, and `OPENAI_API_KEY`, then registers a
  transient OpenAI-compatible provider. That sees only the generated Codex
  projection, not CC Switch's full provider registry.

## Design

### Source Of Truth

Tenon treats `~/.cc-switch/cc-switch.db` as the only normal source for CC
Switch-backed provider discovery.

Discovery succeeds only when all required tables/columns are readable:

- `providers(id, app_type, name, settings_config, meta, is_current, sort_index)`
- `provider_endpoints(provider_id, app_type, url, added_at)`
- `proxy_config(app_type, listen_address, listen_port, enabled, proxy_enabled)`

If the database is absent or the schema is unsupported, Tenon does not surface a
usable CC Switch provider. The UI may show an informational "CC Switch database
not found" or "unsupported CC Switch database" state, but runtime fallback is out
of scope.

### Registry Model

Add a main-process `CcSwitchRegistry` reader that normalizes rows into
read-only source records:

```ts
type CcSwitchAppType =
  | 'codex'
  | 'claude'
  | 'claude-desktop'
  | 'gemini'
  | 'opencode'
  | 'openclaw'
  | 'hermes';

type CcSwitchRouteKind = 'direct' | 'proxy-required' | 'unsupported';

interface CcSwitchProviderSource {
  appType: CcSwitchAppType;
  providerId: string;
  name: string;
  isCurrent: boolean;
  endpoints: string[];
  meta: Record<string, unknown>;
  settingsConfig: Record<string, unknown>;
  authKind: 'api-key' | 'oauth' | 'managed' | 'none' | 'unknown';
  apiFormat: string | null;
  modelId: string | null;
  modelCatalog: CcSwitchModelDescriptor[];
  routeKind: CcSwitchRouteKind;
  disabledReason?: string;
}
```

The reader is read-only. It never updates `is_current`, failover state, health
state, request logs, or proxy config.

### Route Classification

Classify every provider row before exposing it to runtime. Classification is
conservative: if Tenon cannot prove that the provider can be called without CC
Switch's proxy behavior, the row is not direct-runnable.

Direct in the first PR:

- `app_type = 'codex'`
- `meta.apiFormat = 'openai_responses'` or equivalent native Responses signal
- a non-empty endpoint from `provider_endpoints` or the provider's Codex TOML
  config
- `settings_config.auth.OPENAI_API_KEY` is a non-empty string
- a model from the provider's Codex config or model catalog

Proxy-required in the first PR:

- Codex providers with `meta.apiFormat = 'openai_chat'`
- OAuth/session/managed-account providers, including ChatGPT/Codex OAuth and
  other CC Switch-managed token shapes
- providers whose working behavior depends on CC Switch failover, request
  overrides, custom user-agent routing, or protocol conversion
- non-current providers that can only be exercised through CC Switch Local Proxy
  without Tenon writing to CC Switch state

Unsupported in the first PR:

- provider rows with unrecognized auth shape
- provider rows with no endpoint and no proxy path
- app types whose direct adapter has not been mapped yet

The first PR may include direct support for other app types only when the mapping
is mechanical and covered by tests, for example Claude rows with native Anthropic
API-key credentials and a native Anthropic endpoint. If that broadens the PR too
much, keep those rows visible but disabled with a precise reason.

### Runtime Provider Shape

Keep a single user-facing provider group named **CC Switch**. Under that group,
list runnable registry sources as model choices with labels that include the CC
Switch app and provider name, for example:

- `Codex / OpenAI / GPT-5.5`
- `Codex / DeepSeek / deepseek-chat`
- `Claude / Anthropic / Claude Opus 4.8`

Internally, do not overload one provider-level credential for every source.
Register ephemeral runtime providers per source, keyed by app type and provider
id, such as:

```ts
cc-switch:codex:023a77b3-d85f-466a-b93c-9732e74f7c9f
```

The exact internal id is an implementation detail, but it must be stable for a
running process and must not expose secret material. The runtime auth resolver
reads the matching source record from the database at call time so key switches
in CC Switch are picked up without Tenon persisting the key.

### Model Discovery

Model discovery is registry-first:

1. Prefer CC Switch's provider-level model catalog when `settings_config` includes
   `modelCatalog.models`.
2. Fall back to the configured model in the provider config.
3. For native Responses direct providers, model-list probing is optional and must
   not be required for the provider to be runnable.

Do not call `/models` repeatedly just to decide whether the provider exists.
Provider existence comes from the registry; model-list requests are a manual
refresh/enrichment path and must be bounded.

### Proxy Awareness

Tenon does not require CC Switch Local Proxy for direct-runnable providers.

For proxy-required providers, Tenon checks the `proxy_config` listen address/port
and `/health` endpoint. If the proxy is reachable, Tenon may expose the effective
current provider for that app through the proxy route. If the proxy is not
reachable, the row remains visible but disabled with action copy that tells the
user to start CC Switch Local Proxy.

Tenon must not start the proxy or enable app routing itself. Those are CC Switch
operations.

### Error Handling

Errors from CC Switch-backed providers must identify the route and endpoint:

- direct example: `CC Switch direct request to sub2api.wisebox.ai returned 429`
- proxy example: `CC Switch Local Proxy returned 503 for Codex / DeepSeek`
- unsupported example: `This CC Switch provider requires Local Proxy because its
  upstream format is Chat Completions`

Do not show raw keys or token payloads. When logging, redact auth fields by key
name (`key`, `token`, `secret`, `authorization`, `refresh`, `access`, `password`)
and by known token prefixes.

### UI Behavior

Settings > Providers keeps **CC Switch** as an externally managed provider row.
The row should explain that Tenon reads CC Switch's provider registry and does
not save or reveal CC Switch-managed secrets.

The provider detail/model menu should distinguish states:

- `Ready` for at least one direct-runnable registry source
- `Proxy required` when sources exist but require CC Switch Local Proxy
- `Unsupported` when CC Switch exists but no source can run in Tenon yet
- `Not detected` when the database is missing or unreadable

Disabled rows should be inspectable enough to explain what CC Switch provider was
found and why it cannot run.

### Security And Privacy

- Read only from `~/.cc-switch/cc-switch.db`.
- Do not copy provider credentials into Tenon's storage.
- Do not expose credentials through renderer IPC.
- Do not add generic raw-key IPC for CC Switch sources.
- Keep CC Switch-managed rows out of any "show key", "copy key", or "edit
  credential" UI.
- Treat OAuth/session token shapes as proxy-required or unsupported, never as
  ordinary API keys.

### Implementation Notes

Verify the packaged Electron main runtime supports `node:sqlite`. If it does,
prefer it for a read-only SQLite connection and avoid adding a dependency. If
Electron packaging does not expose `node:sqlite` reliably, the dev agent must
escalate before touching `package.json` / `bun.lock` for a SQLite dependency.

Suggested file areas:

- `src/main/agentSettings.ts` — replace Codex-file mirror discovery with registry
  discovery, route classification, model option generation, refresh behavior, and
  runtime config resolution.
- `src/main/piModels.ts` — register source-scoped transient providers and auth
  resolution without storing CC Switch keys.
- `src/core/localGatewayProviders.ts` — keep user-facing CC Switch constants and
  add route/source ids only if they belong in the protocol surface.
- `src/core/i18n/messages/en.ts` and `src/core/i18n/messages/zh-Hans.ts` —
  update provider notes, disabled reasons, and route-specific errors.
- `src/renderer/ui/agent/AgentSettingsView.tsx` and
  `src/renderer/ui/agent/providerCatalog.tsx` — show registry-backed provider
  states without editable credentials.
- `tests/core/agentProviderCredentials.test.ts` — cover database discovery,
  route classification, direct auth resolution, no Codex-file fallback, and
  redaction.
- `tests/renderer/providerUsability.test.ts`,
  `tests/renderer/agentComposerModelControl.test.tsx`, and
  `tests/e2e/agent-settings.spec.ts` — cover settings/composer behavior.
- `docs/spec/agent-pi-mono-implementation.md` — replace the CC Switch Codex
  mirror contract with the registry-backed contract.
- `docs/spec/design-system/surfaces.md` — update the externally managed secret
  wording if the UI copy changes materially.

## Acceptance Criteria

- AC-1: With a readable CC Switch database containing a Codex
  `openai_responses` provider with an API key and endpoint, Tenon shows CC Switch
  as ready and can stream a minimal model response without reading `~/.codex/*`.
- AC-2: When the CC Switch database is missing or schema validation fails, Tenon
  does not expose a runnable CC Switch provider.
- AC-3: When a Codex provider is `openai_chat`, Tenon marks it proxy-required
  unless CC Switch Local Proxy is reachable and Tenon is explicitly using the
  proxy route.
- AC-4: CC Switch-managed secrets never appear in renderer IPC payloads, settings
  UI, logs, copied text, or Tenon secret files.
- AC-5: Model refresh is registry-first and bounded; a failed `/models` request
  does not make a registry-backed provider disappear when a configured model is
  available.
- AC-6: Route-specific 429/4xx/5xx errors identify whether Tenon used direct
  registry credentials or CC Switch Local Proxy and include the endpoint host
  without exposing credentials.
- AC-7: Existing first-party provider behavior is unchanged.
- AC-8: The spec is updated in the same PR and the plan remains consistent with
  `docs/TASKS.md`.

## Verification

- `bun run typecheck`
- `bun run test:core -- agentProviderCredentials`
- `bun run test:renderer -- providerUsability agentComposerModelControl`
- `bun run test:e2e -- agent-settings`
- `bun run docs:check`
- Manual verification on a machine with CC Switch installed:
  - direct Responses provider streams successfully with Local Proxy off
  - `openai_chat` provider shows proxy-required with Local Proxy off
  - proxy-required copy changes when Local Proxy is reachable
  - no CC Switch key is visible or copyable in the UI

## Open Questions

1. Should the first implementation expose all direct-runnable API-key rows across
   `codex`, `claude`, and `gemini`, or land Codex direct support first while
   showing other app types as disabled registry rows?
2. When CC Switch Local Proxy is reachable, should Tenon expose only the effective
   current provider for that app, or should it still hide proxy-required rows that
   are not current because Tenon is read-only?
3. Should CC Switch registry-backed model labels include the CC Switch `app_type`
   by default, or only when there is more than one app type with runnable sources?

## Subtasks

- [ ] Add a read-only CC Switch registry reader with schema validation and auth
      redaction helpers.
- [ ] Replace Codex-file mirror detection with registry-backed CC Switch
      provider discovery and no fallback.
- [ ] Classify registry rows into direct, proxy-required, and unsupported routes.
- [ ] Register source-scoped transient runtime providers for direct-runnable
      sources.
- [ ] Update settings/composer UI to show registry-backed source labels and
      disabled reasons.
- [ ] Add route-specific error messages and logs with endpoint-host redaction.
- [ ] Update core, renderer, and E2E coverage.
- [ ] Fold the final behavior into `docs/spec/agent-pi-mono-implementation.md`
      and any affected design-system surface notes.
