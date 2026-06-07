---
status: done
priority: P2
owner: cc
created: 2026-05-27
updated: 2026-06-04
---

# Agent OAuth & Managed-Credential Providers

Today the provider settings model every provider as "paste an API key". That is
wrong for two of pi-ai's three auth classes, and it leaves GitHub Copilot /
OpenAI Codex / Claude Pro-Max effectively unusable from the UI.

This plan authenticates providers the way pi expects, with one rule that keeps it
clean: **maximize reuse of what pi-mono already ships, own only what pi cannot
give us.** Everything below is verified against `@earendil-works/pi-ai` and
`@earendil-works/pi-agent-core` `0.78.0` (the exact upstream `pi-mono` HEAD —
no version drift).

## Goal

Present each provider's auth method correctly and resolve its credentials for
real:

- **OAuth sign-in** — Anthropic (Claude Pro/Max), GitHub Copilot, OpenAI Codex —
  get a sign-in flow (loopback *and* device-code), not a key field.
- **Managed-credential** — Amazon Bedrock (AWS), Google Vertex (gcloud ADC) —
  show guidance, never a key field, and actually resolve ambient credentials.
- **API-key** — unchanged.

## Non-goals

- Re-implementing OAuth. pi-ai ships the flows; we orchestrate them.
- A generic "add a custom OAuth provider" UI. Built-ins only at v1.
- Per-model enable/disable or model fetch (separate concern).
- Agent-driven credential reads or writes. The agent diagnoses auth state and
  proposes provider/model switches; sign-in, sign-out, token storage, and raw key
  entry stay in runtime-owned, user-gated paths.
- Sharing the on-disk credential file with a separate `pi` CLI install. We match
  pi's credential *shape*, not its file path — Tenon keeps its own isolated,
  encrypted store (see Decision D1).

## What pi-mono already gives us (and we reuse verbatim)

The whole design hinges on not reinventing these. Each row is a verified upstream
facility we compose rather than rebuild:

| Concern | Upstream facility | How we use it |
|---|---|---|
| Credential **shape** | `coding-agent/src/core/auth-storage.ts` — `AuthCredential = ApiKeyCredential \| OAuthCredential` | Adopt the exact discriminated union (`type: 'api_key' \| 'oauth'`). |
| OAuth **flows** | `getOAuthProviders()`, `getOAuthProvider(id)`, `provider.login(callbacks)`, `provider.refreshToken`, `provider.getApiKey`, `provider.modifyModels` (`ai/src/utils/oauth`) | Orchestrate; never reimplement. Device-code polling is internal to `login()`, so we get it free. |
| Auto-refresh key | `getOAuthApiKey(id, Record<id, OAuthCredentials>)` → `{ newCredentials, apiKey } \| null` | The resolver's oauth branch; persist `newCredentials` on rotation. |
| Env + managed keys | `getEnvApiKey(provider)` (exported) — returns env tokens, and the `"<authenticated>"` sentinel for Bedrock/Vertex when ambient creds are present | The resolver's fallback. Makes managed resolve for free. |
| **Per-call refresh point** | `pi-agent-core` `AgentOptions.getApiKey?: (provider) => Promise<string \| undefined>` — documented for "short-lived OAuth tokens that may expire during long-running tool execution" | The resolver **is** this hook's body. Already wired at `agentRuntime.ts:3339`. |
| Login **orchestration** | `coding-agent` `AuthStorage.login()` + the `OAuthLoginCallbacks` wiring in `interactive-mode.ts` (loopback manual-paste race, device-code, select, abort) | Mirror the proven callback wiring in our IPC bridge. |

What pi does **not** give us, so Tenon owns it (unavoidably):

- The persistence I/O — `FileAuthStorageBackend` is **not exported**; we mirror
  the pattern (read / merge / write) over Tenon's own store.
- The Electron IPC bridge for interactive callbacks — inherently host-specific.
- The managed-provider set — pi-ai inlines `'amazon-bedrock'` / `'google-vertex'`
  in `getEnvApiKey` and exports no classifier; we mirror that one small set.
- At-rest encryption — pi's CLI uses plain JSON + `proper-lockfile`; Tenon
  applies its own security posture (Decision D1).

## Design

### Three invariants (what keeps this clean)

1. **The resolver is auth-kind-agnostic.** Getting a key never branches on
   `oauth` / `managed`. It tries the stored credential, then env. `authKind` is a
   *presentation* concept only.
2. **One credential store, one async resolver.** Storage is a single map; the
   resolver is the single async entry point — and it is the body of pi's existing
   `getApiKey` hook. No second resolution path, no sync key-baking.
3. **Secrets never enter the document and the agent never mutates them.** They
   live in main, in an encrypted file; the agent gets a secret-stripped read-only
   view.

### 1. Credential storage — adopt pi's `AuthCredential` union

Replace today's `SecretFile { keys: Record<string, string> }` with pi-mono's
shape (mirrors `coding-agent/auth-storage.ts`, oauth flattened):

```ts
type ApiKeyCredential = { type: 'api_key'; key: string };
type OAuthCredential  = { type: 'oauth' } & OAuthCredentials; // { type, refresh, access, expires, ... }
type AuthCredential   = ApiKeyCredential | OAuthCredential;

interface SecretFile {
  credentials: Record<string, AuthCredential>; // keyed by providerId
}
```

**Invariant: a provider holds at most one stored credential.** Anthropic's
"sign in *or* paste a key" is a choice, not co-existence — signing in writes an
`oauth` entry, pasting writes an `api_key` entry, switching replaces (with a
confirm). `managed` providers never appear here (nothing to store); env is read
from the environment, never stored.

Per [[no-backward-compat-pre-launch]] there is **no migration**: the schema
changes, the old `keys` field is abandoned, the (dev-only) user re-enters once.

### 2. The resolver — one async function, plugged into pi's `getApiKey` hook

This is the single place any key is resolved. It is auth-kind-agnostic and
obeys the hook contract ("must not throw; return `undefined` when none"):

```ts
async function resolveProviderApiKey(providerId: string): Promise<string | undefined> {
  try {
    const cred = (await readSecretFile()).credentials[providerId];

    if (cred?.type === 'api_key') return cred.key;

    if (cred?.type === 'oauth') {
      const { type, ...stored } = cred;                                 // OAuthCredentials
      const out = await getOAuthApiKey(providerId, { [providerId]: stored });
      if (out) {
        if (rotated(out.newCredentials, stored))                        // only on change
          await persistOAuthCredential(providerId, out.newCredentials); // the sole rotation write
        return out.apiKey;
      }
    }

    return getEnvApiKey(providerId);   // env tokens + managed "<authenticated>" sentinel
  } catch {
    return undefined;                  // hook contract: never throw
  }
}
```

Note there is **no `if (managed)`** — Bedrock/Vertex resolve because
`getEnvApiKey` returns the `"<authenticated>"` sentinel, carried through the
fallback. Managed "just works" as a consequence of invariant 1; it is not a
separate workstream.

**Wiring (kills the current dual path):**

- Agent turns — point the already-wired `AgentOptions.getApiKey`
  (`agentRuntime.ts:3339`) at `resolveProviderApiKey`. pi calls it once per LLM
  call, so OAuth refresh happens at exactly the cadence the hook was designed for.
- Compact-summary (`agentRuntimeContext.ts:215`) — its eager string path also
  calls `resolveProviderApiKey` immediately before the `completeSimple` call
  (`SimpleStreamOptions.apiKey` is a plain string with no callback). Same
  resolver → same freshness. The inconsistency is gone.
- `getActiveProviderRuntimeConfig` stops baking `apiKey` (it is sync and cannot
  `await` a refresh); it returns config only, keys are resolved lazily.

### 3. `authKind` + view model — one source, renderer only renders

Delete the renderer's hardcoded classification (`providerCatalog.tsx`
`PROVIDER_AUTH.kind`). Classification lives once, in main:

```ts
function getAuthKind(id: string): 'api-key' | 'oauth' | 'managed' {
  if (getOAuthProvider(id)) return 'oauth';                 // from pi-ai
  if (MANAGED_PROVIDERS.has(id)) return 'managed';          // mirrors pi-ai's inlined set
  return 'api-key';
}
```

The renderer keeps only a *presentation-copy* table (note text + docs link per
managed provider) keyed by `authKind`/id — it no longer decides the kind.

The view model collapses to the minimal facts the UI needs — all computable
**synchronously** from the secret file + `getEnvApiKey`, with no network refresh:

```ts
interface ProviderAuthView {
  authKind: 'api-key' | 'oauth' | 'managed';
  credentialed: boolean;          // the one authoritative "can use models / show connected"
  hasStoredKey?: boolean;         // distinguishes a pasted key (clearable) from an env key
  oauth?: { connected: boolean; expiresAt?: number }; // expiresAt from creds.expires, no refresh
}
```

This deletes the renderer's boolean-soup: the duplicated
`hasApiKey || hasEnvApiKey || catalog?.hasEnvApiKey` in `AgentComposer` and
`AgentChatPanel` both become `provider.credentialed`. The renderer stops
reasoning about credentials entirely (A2). View is a sync snapshot; resolve is
async refresh — the two never interfere.

### 4. Login flow — one event union, over the existing main↔renderer channel

pi's callbacks (`onPrompt` / `onSelect` / `onManualCodeInput`) are
`Promise`-returning: main must *ask* the renderer and *await* a reply. Do **not**
build a second request/response channel — the just-merged `ask_user_question`
(PR #88) already established main→renderer request/response; reuse it.

Collapse pi's callbacks into one discriminated event so loopback (Anthropic) and
device-code (Copilot/Codex) share one state machine with no special-casing —
mirroring `coding-agent`'s `AuthStorage.login()` wiring:

```ts
type OAuthLoginEvent =
  | { kind: 'auth';        url: string; instructions?: string }          // open URL, waiting
  | { kind: 'device-code'; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { kind: 'progress';    message: string }
  | { kind: 'prompt';      requestId: string; message: string; placeholder?: string }  // needs reply
  | { kind: 'select';      requestId: string; message: string; options: { id: string; label: string }[] }
  | { kind: 'manual-code'; requestId: string };                          // needs reply
```

IPC surface (the new commands land in `core/commands.ts`):

| Direction | Command | Purpose |
|---|---|---|
| renderer→main | `agent_oauth_login(providerId)` | Run `getOAuthProvider(id).login(callbacks)`; on resolve persist `{ type: 'oauth', ... }` and return the updated `AgentProviderSettingsView`. |
| renderer→main | `agent_oauth_logout(providerId)` | Delete the stored credential. |
| renderer→main | `agent_oauth_respond(requestId, value)` | Answer a `prompt` / `select` / `manual-code` event. |
| renderer→main | `agent_oauth_cancel(providerId)` | Aborts via the callbacks' `signal: AbortSignal`. |
| main→renderer | `agent_oauth_event` (push) | The `OAuthLoginEvent` union above. |

`usesCallbackServer?` on the provider tells us loopback is **Anthropic-only**;
Copilot/Codex are device-code, and Anthropic supports manual-code fallback. The
one state machine absorbs all three. After login, when building that provider's
model catalog, run `provider.modifyModels(models, creds)` (Copilot rewrites its
base URL per account).

### 5. UI states (driven solely by `authKind`)

- **api-key** — key field + Advanced (Base URL). Unchanged.
- **oauth, disconnected** — primary "Sign in with <Provider>"; Anthropic also
  "or paste an API key".
- **oauth, in progress** — render the event union: `auth` → "Opened browser,
  waiting…"; `device-code` → large user code + verification URL + countdown;
  `prompt`/`select`/`manual-code` → input/chooser whose answer goes back via
  `agent_oauth_respond`. A cancel button calls `agent_oauth_cancel`.
- **oauth, connected** — "Connected · expires <relative>" + "Sign out"; no key.
- **managed** — the shipped guidance note + docs link, plus a read-only "Check
  credentials" dry-run (cheap, since the resolver already resolves managed).

### 6. Agent self-configuration boundary

One invariant, cross-referenced with (not duplicated by)
[[agent-self-modification]] and the archived agent-tool-permissions hardening
plan:

> **The agent observes; the runtime acts.** Agent tools receive a
> secret-stripped read-only view (`authKind`, `connected`, `credentialed`,
> `expiresAt`, health diagnostics). Sign-in, sign-out, and key entry are
> user-triggered, runtime-owned IPC, never agent-callable; raw keys, OAuth
> access/refresh tokens, AWS credentials, and ADC material never appear in tool
> results or event logs. Provider-health diagnostics are not permission to
> downgrade safety settings.

The agent **may** propose: switching to an already-configured provider; switching
to a model on the active provider; disabling a non-active provider; running a
read-only health check.

## Decisions (formerly open questions)

- **D1 — Storage at rest: `safeStorage`-encrypted, Tenon-isolated.** Encrypt the
  whole secret file with Electron's built-in `safeStorage` (macOS Keychain-backed,
  **zero new dependency**); fall back to chmod-600 plaintext when
  `isEncryptionAvailable()` is false. We adopt pi's credential *shape* but not its
  path/encoding — interop with a separate `pi` CLI is a non-goal, and Tenon's
  userData isolation (A5) + security posture (A3) take precedence over a shared
  file.
- **D2 — Loopback under a packaged sandbox: not a blocker.** `usesCallbackServer?`
  scopes loopback to Anthropic, which also supports manual-code; Copilot/Codex are
  device-code (no loopback). The event union handles all paths.
- **D3 — `modifyModels` timing:** applied at model-catalog build whenever an
  oauth credential exists for the provider (post-login and on reload).

## Rollout

1. **Interface-first PR** (A7 / shared-interface-first) — only `src/core/types.ts`
   (`AuthCredential`, `ProviderAuthView`, `OAuthLoginEvent`) and
   `src/core/commands.ts` (the five commands). These are infrastructure-ownership
   files; land them first so siblings rebase.
2. **Main** — `safeStorage` store with the `AuthCredential` union;
   `resolveProviderApiKey` as the single resolver and `getApiKey` hook body;
   `getAuthKind` / `describeProviderAuth`; login-session orchestration over the
   reused `ask_user_question` channel.
3. **Renderer** — drop `PROVIDER_AUTH.kind` and the boolean-soup; render by
   `authKind`; add device-code / connected / sign-out states.
4. **Spec (A6, same change)** — fold this design into a new "provider credentials
   & auth classes" section of `docs/spec/agent-pi-mono-implementation.md`
   (storage union, kind-agnostic resolver, `authKind` source, login event union).
5. **Tests** — e2e with a mock OAuth provider covering **both** device-code and
   loopback (login resolves → connected → logout), plus resolver unit tests
   (api-key / oauth-refresh-persist / managed-sentinel / env-fallback).

Collision check: `gh pr list` shows no open claim on these files at plan time.

## Implementation checklist

- [ ] `core/types.ts` + `core/commands.ts` interface-only PR.
- [ ] Secret file → `AuthCredential` union; `safeStorage` encrypt + chmod-600
      fallback (no migration).
- [ ] `resolveProviderApiKey` (single async resolver, oauth refresh-persist,
      managed via sentinel); wire as the `getApiKey` hook and the compact-summary
      eager path; stop key-baking in `getActiveProviderRuntimeConfig`.
- [ ] `getAuthKind` from `getOAuthProviders()` + the mirrored managed set;
      `describeProviderAuth` → `ProviderAuthView`.
- [ ] Main-side login orchestration + IPC (`agent_oauth_login` / `_logout` /
      `_respond` / `_cancel` + `agent_oauth_event`), reusing the
      `ask_user_question` request/response channel; `modifyModels` at catalog build.
- [ ] Renderer: delete hardcoded classification + boolean-soup; `authKind`-driven
      sign-in / device-code / connected / sign-out states; Anthropic dual mode.
- [ ] `credentialed` replaces the `canChooseModels` boolean-soup in both composers.
- [ ] Spec section + e2e (device-code & loopback) + resolver unit tests.
