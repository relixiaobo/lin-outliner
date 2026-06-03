---
status: in-progress
priority: P2
owner: cc
created: 2026-05-27
updated: 2026-06-03
---

# Agent OAuth & Managed-Credential Providers

Today the provider settings model every provider as "paste an API key". That is
wrong for two classes of provider that pi-ai already supports, and it leaves
GitHub Copilot / OpenAI Codex effectively unusable from the UI.

## Goal

Authenticate providers the way pi-ai expects, and present each provider's auth
method correctly:

- **OAuth sign-in** providers — Anthropic (Claude Pro/Max), GitHub Copilot,
  OpenAI Codex — get a "Sign in" flow instead of (or alongside) an API key.
- **Managed-credential** providers — Amazon Bedrock (AWS), Google Vertex
  (gcloud ADC) — show guidance, never a key field. (Already handled cosmetically
  by the lightweight fix in PR for `settings-provider-auth-classes`; this plan
  makes them actually resolve credentials.)
- **API-key** providers — unchanged.

## Non-goals

- Re-implementing OAuth ourselves. pi-ai ships the flows
  (`@earendil-works/pi-ai` `utils/oauth`); we orchestrate them.
- A generic "add a custom OAuth provider" UI. Built-ins only at v1.
- Per-model enable/disable or model fetch (separate concern).
- Agent-driven raw credential reads or writes. The agent can diagnose auth state
  and propose provider/model switches, but sign-in, sign-out, token storage, and
  raw key entry stay in runtime-owned UI/IPC paths.

## Background — pi-ai's three auth classes

1. **API key** — most providers. `getEnvApiKey(provider)` returns a key from
   env; we also persist a pasted key in `agent-secrets.json`.
2. **OAuth** — `utils/oauth` exports built-in `OAuthProviderInterface`s for
   `anthropic`, `github-copilot`, `openai-codex` (`getOAuthProviders()`,
   `getOAuthProvider(id)`). Each has `login(callbacks)`, `refreshToken(creds)`,
   `getApiKey(creds)`, optional `modifyModels(models, creds)`. `getOAuthApiKey()`
   returns a fresh (auto-refreshed) key from stored `OAuthCredentials`
   (`{ refresh, access, expires }`). `getEnvApiKey` explicitly returns nothing
   for these.
3. **Managed/ambient** — Bedrock reads AWS profiles/IAM; Vertex reads Google
   ADC. `env-api-keys` intentionally excludes both. No key field applies.

## Design

### Credential storage

Extend the secret file beyond `keys: Record<providerId, string>`:

```ts
interface SecretFile {
  keys: Record<string, string>;            // API keys (today)
  oauth?: Record<string, OAuthCredentials>; // refresh/access/expires per provider
}
```

`getProviderApiKey(providerId)` resolution order becomes:
1. explicit pasted key (`keys`)
2. OAuth credentials → `getOAuthApiKey(providerId, oauth)` (auto-refresh; persist
   the rotated credentials back)
3. `getEnvApiKey(providerId)`
4. managed providers: return `undefined` and let the pi-ai api client pick up
   ambient AWS/Google credentials at request time.

### Login flow (Electron main owns it)

pi-ai's Anthropic flow uses `http.createServer` for the loopback callback and is
"only intended for non-browser environments" — the Electron **main** process is
exactly that. Main runs `getOAuthProvider(id).login(callbacks)`; the callbacks
bridge to the renderer over IPC:

- `onAuth({ url })` → main opens the URL via `shell.openExternal`, renderer shows
  "Waiting for sign-in…".
- `onPrompt` / `onManualCodeInput` → renderer prompts for a pasted code (for
  flows without/blocked loopback).
- `onSelect` → renderer shows a chooser (e.g. Copilot org/domain).
- `signal` → cancel button aborts.

New IPC commands: `agent_oauth_login(providerId)`,
`agent_oauth_logout(providerId)`, plus a push channel for the interactive
callbacks (or a request/response pair the renderer drives). `login` resolves →
persist `OAuthCredentials` → return updated `AgentProviderSettingsView`.

### View model

Add to `AgentProviderConfigView` / `AgentProviderOption` an auth descriptor so
the renderer doesn't hardcode the classification:

```ts
authKind: 'api-key' | 'oauth' | 'managed';
oauth?: { connected: boolean; expiresAt?: number };
```

Source `authKind` in main from `getOAuthProviders()` (oauth) + a small managed
set (bedrock, vertex), defaulting to `api-key`.

Agent-visible provider summaries may include `authKind`, `enabled`,
`configured`, `hasCredential`, `connected`, `expiresAt`, and health diagnostics.
They must never include API keys, OAuth access tokens, refresh tokens, AWS
credentials, ADC material, or raw env values.

### UI states (provider detail)

- **api-key**: today's key field + Advanced(Base URL). Unchanged.
- **oauth, disconnected**: primary "Sign in with <Provider>" button; for
  Anthropic also offer "or paste an API key" (it supports both).
- **oauth, connected**: "Connected · expires <relative>" + "Sign out". Token
  auto-refreshes; no key shown.
- **managed**: the guidance note (already shipped) + docs link; once this plan
  lands, also a "Check credentials" affordance that calls a dry-run.

`canChooseModels` in the Agent category must treat oauth-connected and managed
providers as credentialed (not just "has a key").

### Agent self-configuration boundary

The self-modification tools may propose:

- switching to a provider that is already configured;
- switching to a model exposed by the active provider;
- disabling a provider that is not active;
- running a read-only provider health check.

They must not:

- initiate OAuth login without a visible user action;
- persist pasted keys or OAuth credentials from model-generated text;
- expose raw secrets in tool results or event logs;
- write `agent-secrets.json` directly;
- treat provider health diagnostics as permission to downgrade safety settings.

## Open questions

- Does `getOAuthProvider(...).login` reliably bind a loopback port under a
  packaged app sandbox? If not, fall back to the manual-code path
  (`onManualCodeInput`).
- Where to store `OAuthCredentials` — same `agent-secrets.json` (chmod 600) or
  the OS keychain? Keychain is better but adds a dependency.
- Copilot's `modifyModels` rewrites the base URL per-account; make sure the
  model catalog reflects that post-login.

## Implementation checklist

- [ ] Secret file schema + migration (`oauth` map; backward compatible).
- [ ] `getProviderApiKey` resolution order incl. `getOAuthApiKey` refresh-persist.
- [ ] Main-side login orchestration + IPC (`agent_oauth_login` / `_logout` +
      interactive callback channel).
- [ ] `authKind` / `oauth` on the provider view models, sourced from pi-ai.
- [ ] Detail UI: sign-in / connected / sign-out states; Anthropic dual mode.
- [ ] `canChooseModels` + active-provider usability treat oauth/managed as creds.
- [ ] e2e with a mocked OAuth provider (login resolves, connected state, logout).
