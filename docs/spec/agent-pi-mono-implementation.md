# Agent Implementation With pi-mono

This document describes Tenon's current local agent runtime boundary with
pi-mono as the agent core.

The goal is to reuse pi-mono for model/provider abstraction, streaming, and the
agent loop, while keeping Tenon's local capabilities, document mutations, and
security boundaries in TypeScript.

## Decision

Tenon uses these pi-mono packages:

- `pi-ai`: model/provider registry, message types, tool schema types, streaming,
  tool-call parsing, context overflow helpers.
- `pi-agent-core`: stateful agent loop, tool execution orchestration, steering,
  follow-up work, abort, subscriptions, and message replacement.

Tenon does not directly use `pi-coding-agent` as the product agent runtime. Its
built-in terminal tools are useful implementation references, but Tenon's tools
must execute through the Electron IPC command bridge so file access, bash execution,
document mutation, undo, approval, and workspace boundaries stay under Tenon's
control.

The canonical persistence/rendering/debug model is defined in
`docs/spec/agent-event-log-rendering.md`. pi-mono remains the execution core;
Tenon's durable state is the event log plus referenced payload files.

```txt
pi-ai
  -> provider/model abstraction
  -> streaming assistant events
  -> tool schema and tool-call parsing

pi-agent-core
  -> agent loop
  -> tool call orchestration
  -> Agent state and subscriptions
  -> steer / abort / replaceMessages

Tenon Electron main process
  -> creates Agent
  -> maps pi-mono events into Tenon events and render projections
  -> exposes Tenon tools as AgentTool[]
  -> calls TypeScript tool gateway for local operations

Tenon Electron main process
  -> AgentRuntime session lifecycle
  -> API key / credential storage
  -> bash execution
  -> file operations
  -> outliner reads and mutations
  -> permissions and approval policy
  -> persistence and undo grouping

Tenon renderer
  -> Agent UI only
  -> sends prompt/stop/approve commands
  -> renders shared AgentRuntimeEvent projections
```

## Runtime Boundary

The agent dock remains a cross-tab shell feature. It owns conversation state and
rendering. The outliner owns document state and panel state.

Tenon's product runtime is TypeScript/Electron only. Agent tools, outliner
mutation planning, outline parsing, preview rendering data, validation, undo
grouping, file access, bash execution, and web adapters are implemented through
TypeScript modules under Electron main and `src/core`. Do not introduce a
Rust-side parser or command bridge for the current architecture.

The pi-mono Agent does not live in the renderer. The clean boundary is:

- Renderer: Agent UI, input, transcript rendering, and approval controls.
- Electron main process: AgentRuntime, local security boundary, API key storage, persistence,
  approval enforcement, and tool gateway.
- Electron main process: pi-mono agent loop, provider streaming, context assembly,
  and tool-call orchestration.

Electron main process remains the authority for every operation that touches the
local machine, credentials, or document state. The pi-mono loop may request tool
execution, but the TypeScript tool gateway performs the operation or rejects it.

```txt
Agent input
  -> renderer agent client
  -> Electron IPC command
  -> Electron AgentRuntime
  -> pi-agent-core Agent
  -> pi-ai stream
  -> tool calls
  -> TypeScript tool gateway
  -> TypeScript core / filesystem / shell
  -> tool result
  -> pi-agent-core continues loop
  -> Electron main emits normalized event/projection
  -> renderer transcript
```

The renderer may hold transient UI state, but the main app surface must not hold
provider API keys or directly execute model/tool logic. The only raw-key renderer
exception is the provider config child window's user-clicked show/copy path for a
stored user-pasted key; main rejects that IPC from any other sender. This keeps a
future Tenon-owned agent core possible: it only needs to implement the
AgentRuntime event/command contract.

## Package Usage

pi-mono packages are pinned dependencies. Do not use floating major or minor
versions until Tenon has its own compatibility tests around the adapter.

```json
{
  "dependencies": {
    "@earendil-works/pi-ai": "0.80.3",
    "@earendil-works/pi-agent-core": "0.80.3"
  }
}
```

If pi-mono changes package ownership or names, keep the imports behind Tenon's
own adapter modules so product code does not depend on package names directly.

pi-ai's chat and image-generation surfaces are separate. Chat/agent runtime
model calls use `Models`; generated images use `ImagesModels`. Tenon exposes
image generation through a Tenon-owned `generate_image` tool instead of exposing
pi-ai's image API directly to the product surface. Provider configuration remains
a connection/capability record: credentials, endpoint, enabled state, validation,
and capability discovery. It does not store language or image default models.

Image-capable provider support lives behind `src/main/piImageModels.ts`. The
adapter reuses the same pi credential store as language models, registers
Tenon-owned first-party OpenAI and Google Gemini image providers, and keeps
OpenRouter image models available through pi-ai's built-in image provider when
OpenRouter is configured. A disabled or uncredentialed provider is excluded from
both chat model routing and image model routing. Provider-specific image option
normalization and preflight validation also live in this adapter; the
`generate_image` tool receives only a structured unsupported-option result when a
requested option cannot be sent to the selected provider/model. OpenAI-specific
image constraints are kept here rather than in the generic tool schema so other
image providers can keep their own size, aspect-ratio, background, and output
format semantics. Image generation calls inherit the same provider-row
credential and endpoint settings as chat calls, including a custom Base URL for
an OpenAI-compatible endpoint, so users configure a provider connection only
once.

Current module boundary:

```txt
src/core/agentTypes.ts
  # shared AgentRuntimeEvent, event-log DTOs, render projection DTOs, and IPC event channel

src/core/agentEventLog.ts
  # shared AgentEvent, payload refs, replay reducers, branch projection, and
  # pi-mono message projection

src/main/agentRuntime.ts
  # owns pi-agent-core sessions, command transport, event append, and projection
  # forwarding

src/main/agentEventStore.ts
  # target-oriented agent event-log storage and payload/checkpoint layout

src/preload/index.ts
  # exposes typed command and event bridge to the renderer

src/renderer/agent/
  runtime.ts              # UI client for Electron AgentRuntime
```

Only Electron main process agent modules should import pi-mono directly.
Renderer and preload code should depend on shared Tenon-owned DTOs from
`src/core/agentTypes.ts`, not pi-mono package types and not renderer-owned
types.

## Agent Runtime

Tenon wraps pi-agent-core inside Electron main process. Product UI talks to
Electron AgentRuntime through a renderer `useLinAgentRuntime` client, never to a raw
pi-mono Agent.

Responsibilities:

- Electron main process: create and configure the pi-mono `Agent`.
- Electron main process: set the active model, system prompt, and tool list.
- Electron main process: start conversations, route prompts, stop runs, and manage runtime lifecycle.
- Electron main process: resolve API keys at stream time.
- Electron main process: execute or reject every local tool call.
- Electron main process: subscribe to Agent events and append normalized Tenon events.
- Electron main process: derive render/debug/pi-mono projections from the event store.
- Renderer: render projections and send user intents.

Conceptual shape:

```ts
interface AgentRuntimeClient {
  restoreLatestConversation(): Promise<AgentConversation>;
  restoreConversation(conversationId: string): Promise<AgentConversation>;
  createConversation(options: { title?: string }): Promise<AgentConversation>;
  closeConversation(conversationId: string): Promise<void>;
  sendMessage(conversationId: string, message: string, attachments?: AgentMessageAttachmentInput[]): Promise<void>;
  editMessage(conversationId: string, nodeId: string, message: string): Promise<void>;
  regenerateMessage(conversationId: string, nodeId: string): Promise<void>;
  retryMessage(conversationId: string, nodeId: string): Promise<void>;
  switchBranch(conversationId: string, nodeId: string): Promise<void>;
  queueFollowUp(conversationId: string, message: string): Promise<{ queued: boolean }>;
  clearFollowUp(conversationId: string): Promise<void>;
  stopConversation(conversationId: string): Promise<void>;
  onEvent(listener: (event: AgentRuntimeEvent) => void): (() => void) | null;
}
```

The boundary exposes Tenon-owned runtime events, render projections,
attachment DTOs, debug DTOs, and UI state. Conversation content types should
reuse pi-ai block shapes where possible so Tenon does not maintain a parallel,
shape-compatible copy of `TextContent` or `ImageContent`. Persisted conversation
identity, branching, tool lifecycle, approvals, and debug records are Tenon-owned
event-log concepts, not pi-mono runtime state.

Session listing, rename/delete, debug history, debug payload reads, payload text
reads, reset, and provider settings are separate Electron IPC commands that use
the same Tenon-owned DTO boundary.

## Local File Mentions

The composer may insert local files, folders, and images as inline mention
atoms. The user-facing editor and transcript render these as natural `@name`
tokens. Path-backed local files and folders use structured model-facing
positional markers: `[[file:<label>^<path>]]`. The `path` value is
percent-encoded in the marker. Images also get a normal file marker; their
image bytes are sent separately as pi-ai image content blocks. Attachments
without a stable local path are staged under the agent local file root first, so
the model-facing marker still points at a path that local file tools can read.

`label` is a stable, human-readable reference for one user turn. It is derived
from the selected file name, sanitized to one line, and de-duplicated within the
turn when multiple attachments would otherwise collide. The marker value is the
local path; renderer-only attachment ids may exist for editing and deletion, but
they must not be required for model interpretation.

Normal new turns do not include hidden `<user-attachments>` JSON. The
`[[file:<label>^<path>]]` marker is the model-visible resource contract. Runtime
attachment payloads are still used internally for image content blocks,
renderer-to-main staging, materialized paths, and historical transcript replay.

When the user writes `[[file:<label>^<path>]]`, the agent should use the
percent-decoded path. Image attachments are also visible as image content
blocks. Local files and folders are available by path and should be inspected
with `file_read` or `file_glob`; the model should not assume file contents are
already present.

Clipboard images and temporary files follow the same contract: Tenon materializes
or inlines the data as needed, gives it a friendly `ref`, and records enough
hidden context for the model to resolve that `ref`.

## Model Configuration

Tenon should use `pi-ai` for known provider and model metadata, but Tenon should own
the user's provider settings.

Multimodal user turns should use pi-ai's native `ImageContent` shape:
`{ type: "image", data: base64, mimeType }`. Provider adapters then translate
the same Tenon message to Anthropic base64 image blocks, OpenAI image URLs,
Gemini inline data, and other upstream formats.

Model configuration should include:

- Provider id.
- Model id.
- API key reference or local secret key name.
- Optional base URL.
- Optional API protocol override for OpenAI-compatible providers.
- Reasoning level if the selected model supports it.
- Runtime agent settings: permission mode, skill toggles, compact toggle,
  additional skill/agent directories, provider timeout, provider retry count,
  provider retry-delay cap, and prompt cache retention.

The API key should be read at stream time through Tenon's TypeScript credential path. It
should not be embedded into persisted agent messages, tool results, renderer
state, or IPC command payloads.

Tenon currently stores provider settings and secrets in app-data files owned by
TypeScript:

```txt
agent-providers.json
  -> activeProviderId
  -> agent: runtime agent settings
  -> providers: providerId, baseUrl, enabled        // connection only
  -> builtInAgentProfiles: agentId -> { model?, effort? }  // built-in default overlay

agent-secrets.json
  -> credentials: providerId -> AuthCredential
       AuthCredential = { type: 'api_key'; key }
                      | ({ type: 'oauth' } & OAuthCredentials)   // refresh/access/expires
  -> local plaintext JSON with private file permissions (`0600`) where the OS
     supports it; never written to the document, renderer state, or agent logs
```

Renderer-facing agent commands may return provider configuration plus an `auth`
descriptor (`authKind`, `credentialed`, `hasStoredKey`, oauth `connected` /
`expiresAt`), but must never return the API key, OAuth access/refresh token, AWS
credential, or ADC material itself. The provider config child window has one
dedicated non-command IPC, `lin:get-provider-api-key`, guarded by
`event.sender === providerConfigWindow.webContents`, for the explicit show/copy
UI described below. Runtime provider resolution happens through Electron
AgentRuntime or the TypeScript tool/provider gateway — see
[Provider Authentication](#provider-authentication).

### Connection-only providers; the agent profile owns model + effort

A provider row is a **connection** (credentials + endpoint), not a model choice.
`AgentProviderConfig` is `{ providerId; baseUrl?; enabled }` — it neither requires
nor semantically owns `modelId` / `reasoningLevel`. The provider config window is
correspondingly connection-only: credential or provider-specific auth, optional
Base URL, `Test connection`, and Save / remove — no model or thinking-level
picker, for catalog and custom OpenAI-compatible providers alike.

Model and effort are owned by the agent identity that actually runs:

- **User / project agents** keep `AgentDefinition.model` / `AgentDefinition.effort`
  (persisted to the agent's `.md` / `.json`).
- **The built-in assistant** is code, so the user's edits — display name, persona,
  tools, skills, model, effort — live in a settings-owned overlay keyed by
  `agentId` (`builtInAgentProfiles` above), reachable via `getBuiltInAgentProfile`
  / `setBuiltInAgentProfile`. Two entry points write the same overlay: the
  Settings → Agent profile editor and the composer's quick model/effort chip
  (`AgentComposerModelControl`, model/effort only). Its main menu shows only the
  *results* — the current reasoning level and the current model — as two rows that
  each open a side-anchored flyout submenu: the reasoning levels (`off` is a level,
  not a toggle; the level inherit resolves to is badged "Default"; a help line on
  top), and the model list grouped by provider with each provider's recent models
  (catalog is ranked newest-first) shown and the older tail behind a per-provider
  "Show all" — so a long catalog and a second provider stay reachable. The
  default-level math (`medium` coerced to the model's nearest supported level) lives
  in `core/agentReasoning` (`defaultThinkingLevelFor` / `nearestSupportedLevel`),
  shared by the runtime and this picker so they never disagree. Both round-trip the
  current
  definition and persist only the fields that differ from the code base (so an
  unchanged persona is never frozen), and `updateAgentDefinition` reconfigures the
  live conversations so an edit takes effect on the **next turn**, not only on
  reopen. `state.systemPrompt` is always refreshed; `state.model` / `thinkingLevel`
  are re-resolved and swapped **only when the edit actually changed model or
  effort** (`builtInModelEffortChanged`). The built-in defaults to `model:'inherit'`,
  so re-resolving on every save would silently switch a running conversation's model
  to whatever provider is active *now* whenever the user merely edited the persona —
  a change they never made; gating on the real model/effort diff prevents that. The
  stable `name` (Neva's memory anchor) is never overlaid.

The Settings → Agent profile selector (`AgentModelEffortSelector`) is
**capability-driven**: pick a provider, then a model; the
effort options are derived from that model's `supportedThinkingLevels`. The
model option also carries model-specific effort display labels derived from the
provider adapter's thinking map for every canonical level, so a model that exposes
only a small subset such as low/high, or a highest level called `XHigh` / `Max`,
displays that model's levels without writing a provider-specific string into the
agent profile. The
composer chip presents the same catalog as the Codex-style menu above instead, but
writes the identical values. A provider is a model-selection capability only when
its connection is both enabled and credentialed/reachable; disabled providers stay
out of every model picker even if they still have a stored API key. A stale saved
model from a disabled provider is reconciled back to inherit in the Settings
selector, and the composer chip resolves back to the first usable provider's
default instead of offering that disabled provider's catalog. Saved values are the
canonical model id (provider-qualified `providerId/modelId`) and the
adapter's canonical effort, never a display label. The provider→model string is
parsed by one shared `core/agentModelId` helper (renderer + runtime), so a model id
that itself contains `:` (Bedrock `amazon.nova-lite-v1:0`, Vertex inference
profiles) is never mis-split — `/` is the canonical qualifier and `:` only splits
when its prefix is a known provider.

**`agentTestProviderConnection` validates reachability, not a chosen model.** Probe
order: if the connection has a **custom base URL** (a proxy/gateway that may not
host the catalog's first model), list the endpoint's own models first
(`GET {baseUrl}/models`, `listOpenAiCompatibleModels`) — any model proves
reachability. Otherwise (or if listing is unsupported but a catalog exists), send a
1-token completion against the first ranked catalog model
(`firstRankedModel`/`rankedModels`). If neither proves reachable, return an honest
"endpoint reached but no usable model" error. A listing failure with no catalog
model to fall back to surfaces its status (401/404/timeout) directly. The probe is
bounded: short timeout, tiny output budget, cancellable UI.

**Runtime model resolution** (`agentRuntime.ts`):

1. Resolve the active usable provider connection.
2. Resolve the running agent's model/effort: user/project override → built-in
   assistant overlay default → catalog first-ranked fallback (last-resort first-run
   default), through one shared `resolveAgentModelEffort` helper. When the profile
   sets no effort, the default is **`medium`** coerced to the model's nearest
   supported level (a non-reasoning model that supports only `off` stays `off`) —
   a reasoning-capable model reasons by default rather than silently running off.
   The catalog fallback is resolved lazily, so an explicit, resolvable model never
   triggers a catalog ranking sort.
3. Build the provider `Model` object with the connection's auth / base URL. For
   custom OpenAI-compatible endpoints, dispatch uses the internal
   `tenon-custom:<providerId>` provider, while the model's API adapter follows
   the known catalog model when one exists (`gpt-5.x` OpenAI models keep
   `openai-responses`; unknown proxy-only models default to
   `openai-completions`). A known catalog model id also keeps its neutral
   sizing/capability metadata (`contextWindow`, `maxTokens`, `reasoning`,
   thinking map, cost/input`) so compaction and overflow math do not fall back to
   generic custom-model defaults. Provider prompt-cache affinity follows the
   runtime cache setting for both official OpenAI and custom OpenAI-compatible
   Responses endpoints, so cache-capable gateways can return cache-read usage
   instead of forcing every turn to resend the full long transcript. Custom
   Responses endpoints additionally receive Tenon's compatibility payload profile:
   leading system/developer input is promoted to top-level `instructions`, text
   verbosity is set to `low`, and tool requests include automatic tool choice plus
   parallel tool calls when tools are present. This keeps Tenon's generic
   OpenAI-compatible dispatch closer to the stable Codex-style Responses shape
   without copying provider-specific model headers or compatibility overrides onto
   the custom endpoint model. Automatic compaction follows the Codex-style token
   accounting policy for all providers: the threshold is 90% of the model context
   window, and Tenon prefers the latest provider-reported context usage plus any
   locally-added tail after that response; local message estimation is only the
   fallback when no provider usage has been observed yet. If a custom Responses
   stream terminates after a complete tool call has already arrived but before the
   final terminal response event, Tenon treats that narrow case as a `toolUse`
   completion and continues to execute the tool instead of discarding the complete
   tool call as a provider failure.
   The custom endpoint's request-auth resolver prefers, in order: an explicit
   request key → a deliberately-stored `api_key` → (local endpoints only) an
   inert client key → the external provider's ambient auth. A keyless localhost
   server stays runnable through the inert key, but an **ambient** provider key
   (env / OAuth / managed) is never forwarded to localhost; a keyless *remote*
   endpoint resolves no credential and fails rather than borrowing one.

Assistant events still record the actual `providerId`, `modelId`, `usage`, and
thinking level so Details / debug stay faithful — the connection-only storage
change does not strip per-message model metadata.

## Provider Authentication

pi-ai recognizes three credential classes, and Tenon presents each correctly
instead of modeling every provider as "paste an API key":

1. **API key** — most providers. A user-pasted key persists in
   `agent-secrets.json`; `getEnvApiKey(provider)` supplies an ambient env key.
2. **OAuth sign-in** — Anthropic (Claude Pro/Max), GitHub Copilot, OpenAI Codex.
   pi-ai ships the flows (`getOAuthProvider(id)`); Tenon orchestrates them and
   stores the resulting `OAuthCredentials` (`{ refresh, access, expires }`).
3. **Managed / ambient** — Amazon Bedrock (AWS profiles/IAM) and Google Vertex
   (gcloud ADC). No key field applies; the pi-ai api client reads ambient
   credentials at request time.

`authKind` (`'api-key' | 'oauth' | 'managed'`) is classified in main from
`getOAuthProviders()` plus a small managed set, defaulting to `api-key`, and
flows to the renderer on the provider view models so the UI never hardcodes the
classification.

### CC Switch provider registry

Tenon treats CC Switch as an external provider manager and reads
`~/.cc-switch/cc-switch.db` as the only normal source for CC Switch-backed
provider discovery. Main validates the required `providers`,
`provider_endpoints`, and `proxy_config` columns before using the database. If
the database is missing or the schema is unsupported, Tenon does not fall back to
Codex-generated files and does not expose CC Switch as runnable.

The `cc-switch` row remains declared through the local gateway provider registry
(`src/core/localGatewayProviders.ts`). That registry owns the user-facing
provider id/name, adapter id, external-secret flag, quick-enable behavior,
refreshability, and catalog-provider fallbacks. The CC Switch adapter in main
reads provider rows into source records containing app type, provider id/name,
endpoints, metadata, settings config, auth kind, API format, model catalog, and
route classification. Those source records stay main-process only.

Route classification is conservative. The first direct route supports Codex
sources whose CC Switch metadata identifies native OpenAI Responses routing, a
direct endpoint, an API-key credential, and at least one configured model.
Codex `openai_chat` sources, OAuth/session/managed-account shapes, failover or
request-override configurations, and sources that require protocol conversion
are marked **Proxy required**. Known app types without a direct adapter are
shown as **Unsupported**. A configured Tenon row with no readable registry is
shown as **Not detected**.

Tenon keeps one user-facing provider group named **CC Switch**. Direct-runnable
registry sources are exposed as model choices under that group with labels such
as `Codex / OpenAI / GPT 5.5`. Internally, each source gets a stable
source-scoped provider id like `cc-switch:codex:<provider-id>`, and the visible
model id encodes that source id plus the upstream model id. The pi auth resolver
decodes the model id at request time, re-reads the matching source from the CC
Switch registry, and returns only that source's API key to the provider request.
The group-level `cc-switch` provider has no show/copy/edit credential surface,
and Tenon never copies CC Switch-managed keys into `agent-secrets.json`.

Model discovery is registry-first. Tenon prefers
`settings_config.modelCatalog.models`, then the configured model id in the
provider settings. The explicit **Refresh models** action re-reads the registry
and rebuilds source-scoped model options; it does not require `/models` to prove
provider existence. Failed model-list probing cannot make a registry-backed
provider disappear when the registry already supplies a model.

CC Switch Local Proxy is not used for direct-runnable sources. Proxy-required
sources remain visible with a route-specific disabled reason; Tenon does not
start the proxy, enable app routing, write CC Switch state, or switch CC
Switch's current provider. Future proxy-route support must remain explicit so
Tenon can distinguish direct registry credentials from Local Proxy routing in
errors and diagnostics.

### Single credential resolver

`getProviderApiKey(providerId)` is the one resolution path, used at stream time
and by connection validation. It never throws — a failure resolves to "no key".
Resolution order:

1. a stored `api_key` credential (user-pasted);
2. a stored `oauth` credential → `getOAuthApiKey(...)`, which auto-refreshes and
   returns a fresh key; the rotated `OAuthCredentials` are persisted back;
3. `getEnvApiKey(provider)` (an ambient env key, or the managed sentinel for
   Bedrock/Vertex);
4. otherwise undefined — the api client falls back to ambient credentials.

The resolver is wired as pi-agent-core's per-call `getApiKey` hook, so OAuth
tokens refresh transparently across a long run.

### Login flow (main owns it)

pi-ai's loopback flow binds `http.createServer` and is intended for non-browser
environments — the Electron **main** process. Main runs
`getOAuthProvider(id).login(callbacks)`; a pure orchestration (`agentOAuth.ts`)
bridges pi-ai's callbacks to the renderer as a single `OAuthLoginEvent` union
over one push channel, correlates the reply-needed steps (`prompt` / `select` /
`manual-code`) by `requestId`, and supports cancellation via an
`AbortController`. The production composition root (`agentOAuthManager.ts`)
injects the real provider lookup and secret-store persistence, so the
orchestration carries no native dependency and is unit-testable with fakes.

IPC: `agent_oauth_login(providerId)` resolves with the updated
`AgentProviderSettingsView` after persisting credentials;
`agent_oauth_logout(providerId)` drops the stored credential;
`agent_oauth_respond(requestId, value)` answers a reply step (undefined =
cancel); `agent_oauth_cancel(providerId)` aborts an in-flight sign-in. The
interactive events are pushed renderer-bound on `lin-agent-oauth-event`.

Sign-in, sign-out, token storage, and raw key entry are runtime-owned,
user-gated paths. The agent may read auth state (`authKind`, `connected`,
`expiresAt`, health) and propose provider/model switches, but never initiates a
login, persists a credential from model-generated text, writes the secret file,
or sees a raw key / token / AWS credential / ADC material in any tool result or
event log.

### Provider detail UI states

- **api-key** — the key field + base URL. A stored user-pasted key renders as an
  empty field with a saved-key placeholder until the user explicitly clicks show
  or copy; that action uses the provider-config-window-only
  `lin:get-provider-api-key` IPC to fetch only the stored `api_key` secret for
  this provider.
  It never resolves env keys, OAuth access tokens, managed credentials, or local
  endpoint sentinels into the renderer.
- **oauth, disconnected** — a "Sign in with <Provider>" button; Anthropic also
  offers "use an API key instead" (it accepts both).
- **oauth, in progress** — device-code (code + verification URL + TTL countdown)
  or loopback ("open the sign-in page"), plus the interactive prompt / select /
  manual-code steps and a cancel control.
- **oauth, connected** — a neutral "Connected" confirmation with the relative
  renewal time, plus "Sign out" and "Re-authenticate".
- **managed** — the guidance note + docs link; no key field.

Usability (`canChooseModels`, active-provider resolution) treats oauth-connected
and managed providers as credentialed via a single `auth.credentialed` signal,
not "has a pasted key". Credentialed and enabled are separate states: a provider
can keep its stored credential but be disabled so it is not eligible to run.

### Provider capabilities

Provider view models expose typed capability summaries so the renderer never has
to infer capabilities from model id strings. The legacy `models` field on
`AgentProviderOption` remains the language-model list for existing consumers.
Additional capability sections live under `capabilities`:

```ts
type AgentProviderCapabilityKind = 'language' | 'image_generation';
type AgentProviderCapabilityIO = 'text' | 'image';

interface AgentProviderCapabilitySummary {
  kind: AgentProviderCapabilityKind;
  models: AgentProviderCapabilityModelOption[];
}
```

The provider detail window renders capabilities as informational sections:
language models, image-generation models, and future capability groups. It does
not ask for or persist a default model. The composer/model picker reads only
enabled providers' language models. The `generate_image` tool reads
image-generation models and the separate `imageGeneration.defaultModel` tool
preference; that default is stored outside provider connection rows and uses the
canonical provider-qualified `providerId/modelId` format, with empty meaning
Auto.

### Provider rows are deliberate; state cannot contradict

A row in `agent-providers.json` means the user deliberately added a provider — it
is never a side effect of saving unrelated settings. Two rules keep `configured`
(has a row) and `credentialed` (has a usable key / oauth / env key) from diverging
into the "needs a key, yet offers *Remove provider*" contradiction:

- **Row creation lives in explicit provider actions.** The per-provider config
  window (`upsertProviderConfig`, after the credential is stored), OAuth login
  (`ensureProviderConfig`, after the credential is persisted), and detected
  externally configured provider enable switches such as CC Switch can create or
  edit a provider row. The main
  Settings pane's Save persists only runtime settings (permissions / skills /
  agents); it never upserts a provider. An upsert has no auto-activation side
  effect — a provider becomes active only on a deliberate user action, or via the
  active-provider fallback at read time (the first credentialed and enabled row),
  which the startup reconcile below later persists. Saving credentials or base
  URL for an existing row preserves that row's `enabled` flag; it does not
  silently re-enable a disabled provider. A new row defaults to enabled.

- **Enabled is explicit.** Every configured provider row has an enable switch.
  Disabling a row keeps credentials and endpoint configuration intact, clears the
  active pointer if that row was active, hides "Set as Active", and removes the
  row from runtime/provider fallback candidates. Re-enabling makes the row
  eligible again but does not auto-activate it.

- **Reconcile once at startup, never on the read path.** `reconcileProviderConfig`
  runs as a fire-and-forget step in `app.whenReady` (not inside
  `getProviderSettings`, which is a pure read). It prunes a *junk* row and repoints
  a now-dangling `activeProviderId`, persisting only when something changed. Two
  invariants keep a transient or ambient signal from becoming permanent data loss:

  - **Unreadable secrets => do nothing.** If the secrets file can't be read,
    reconcile prunes nothing and writes nothing; the credential picture is
    unknown. It reads via `readSecretsWithStatus` (reports `readable`), never the
    degrading `readSecretFileSafe`.
  - **Prune only on durable signals.** A row is *junk* only if it is a plain
    `api-key`-kind catalog row with **no stored secret-file credential and no
    `baseUrl`**. Any `baseUrl` is a deliberate endpoint row and survives startup
    cleanup; if it is keyless and remote, runtime usability still depends on
    stored or ambient auth. Managed (Bedrock/Vertex) and oauth kinds are exempt
    outright, and ambient `getEnvApiKey` is **not** consulted — a Finder/Dock
    launch inherits no shell env, so judging on env would delete a deliberate row
    whenever the env happens to be absent. `activeProviderId` is repointed only
    when unset or structurally dangling (no surviving row by that id), targeting
    the first row with a durable stored credential; read paths
    (`resolveUsableActiveProvider` / `getActiveProviderRuntimeConfig`) still fall
    back through env/managed at runtime.

  A legit keyless endpoint row survives; only catalog junk rows are removed. This
  makes the contradiction structurally impossible for the legacy junk shape
  without deleting deliberate endpoint configuration, and keeps cleanup off the
  read path so a write never races concurrent writers. Per the pre-launch
  no-migration policy this reconcile (plus a dev `userData` wipe) is the only
  cleanup; there is no versioned migration.

## System Prompt

Tenon follows the prompt layering principle used by stable agent runtimes,
choosing each fact's home by **how often it changes** — the cheapest correct slot
for each:

- The **stable system prompt** carries only what holds on every turn: universal
  firmware, capability modules, and the agent's persona. It is cached as the
  prompt prefix.
- **Tool descriptions** carry tool-operating conventions — call syntax, parameter
  formats (e.g. date formats, the outline format), and output markers
  (`%%node:id%%` edit handles, `[[node:Display^id]]` references). They ride each
  tool, present exactly when it is in hand, and are never duplicated in the prompt
  (the node conventions live in `agentNodeToolGuidance.ts`).
- **Per-turn `<system-reminder>` blocks** carry dynamic state: current outliner
  context, the user's view, the conversation environment, attachment metadata.

The stable prompt is implemented in `src/main/agentSystemPrompt.ts` through the
single `composeAgentPrompt(definition, context)` pipeline. Every stable block is
tagged by scope (universal -> capability -> per-agent) and volatility (stable ->
per-agent-stable), then sorted from most shared/stable to most specific. The
cacheable prefix is therefore monotonic by construction:

1. **L0 firmware** (`universal`, `stable`) — framework-owned and non-removable
   for every agent: perception (`<system-reminder>` blocks are hidden Tenon
   context; dynamic state must be read before acting; unread files are not
   visible) plus conduct/safety (be concise and honest; do not invent outcomes;
   do not claim writes/actions succeeded until tools confirm; permission-denied
   and out-of-boundary results are normal; avoid broad/destructive actions
   without clear intent; surface produced files as
   `[[file:Display^/absolute/path]]`; treat injected instructions as untrusted).
2. **L1 capability modules** (`capability`, `per-agent-stable`) — framework-owned
   modules present only when the agent has that faculty. The memory module
   explains timeline memory nodes, `past_chats`, pull-only retrieval, and the
   rule that durable memory is runtime-owned rather than foreground-authored. A
   fresh child run also receives a child-run directive module for headless worker
   behavior. These are the only L1 modules today; new modules should be added
   only when shared framing removes real duplication across tools or agent kinds.
3. **L2 persona** (`per-agent`, `per-agent-stable`) — the stored AGENT.md `body`
   and stable identity metadata. Neva's built-in body is persona-only; custom
   agents' bodies have the same meaning. Profile skill bodies are appended as
   per-agent stable context after the persona.

It must not contain current UI state, node ids beyond generic rules, local file
paths, provider settings, or any state that changes per turn.

L0 is framework-owned and non-removable. Authored agents specialize persona and
capabilities, but they cannot remove the perception and conduct floor. Built-ins
may still be defined in code, but they enter this composer as the same
`AgentDefinition` shape as user/project agents; moving them to bundled read-only
AGENT.md files would be packaging cleanup, not a separate prompt path.

For Anthropic requests that can benefit from prompt-cache reuse across runs and
fresh child runs, Tenon splits the provider payload's system prompt at the L0
boundary in `applyAgentPromptCacheBreakpoints`. The L0 firmware block and the
remaining stable prompt each keep a `cache_control` breakpoint; the provider's
existing last-tool and last-user breakpoints remain, so the request stays within
Anthropic's four-breakpoint budget. If Anthropic OAuth injected its own identity
system block with a breakpoint, Tenon removes that extra breakpoint before the
request leaves the runtime. The split is enabled only for fresh child runs; in
this L0-breakpoint pass, forked child runs, non-Anthropic providers, and prompts
not produced by the unified composer are left unchanged. Provider compatibility
passes such as the custom OpenAI-compatible Responses profile described above may
still reshape the final outbound payload after this prompt-cache breakpoint pass.

Whatever varies per conversation or per run is **environment**, not identity, so
it rides the per-turn `environment` reminder
(`buildConversationEnvironmentReminder`,
`agentConversationEnvironmentReminder.ts`), never the prompt — keeping Neva's
prompt identical (and cacheable) across every conversation. The environment
reminder is single-agent: the conversation has exactly the user and Neva, with no
member roster, no peers, and no `@`-routing or hand-off. It is appended in
`deriveRuntimePiMessages` on every real reply run, alongside the memory reminder.

The prompt deliberately omits the **environment** — what Tenon is (an outliner
and second brain) and what good structure looks like here (atomic nodes, clean
nesting, one idea per line). Environment is not identity: keeping it out leaves
Neva's prompt identical and cacheable across every conversation. (Stable product
framing and structure taste are intended to ride a once-at-conversation-start
reminder — like the user-view snapshot, sent once and not repeated; until then
they surface implicitly through the tools and the outliner-context/user-view
reminders.)

Avoid putting implementation details such as React component names or internal
TypeScript function names into the system prompt unless a tool needs them.

## Context Construction

Each prompt should include a compact context block built by Tenon, not by pi-mono.

Default context:

- Active tab id.
- Active panel id.
- Selected node ids in the active panel.
- Visible node summary for the active panel.
- Recently edited or mentioned nodes when available.
- Current local time.
- Current permission mode for file and shell tools.

The context builder should be deterministic and bounded. It should not dump the
entire document unless the user explicitly asks for whole-document work.

```txt
User prompt
  -> context.ts builds active outliner context
  -> runtime sends messages to Agent
  -> transformContext applies tool-output budget, microcompact, and auto compact
```

Tenon uses pi-mono's `transformContext` hook for request-time context shaping and
the runtime's `afterToolCall` hook for immediate large-result persistence. The
compaction policy stays in Tenon so it can preserve outliner-specific anchors,
skills state, and event-log replay semantics.

## Tool Model

All tools exposed to pi-agent-core should be Tenon tools. A tool is a TypeScript
adapter around a Electron IPC command.

```txt
AgentTool.execute(args)
  -> validate args
  -> check permission/block policy
  -> invoke Electron IPC command
  -> normalize result
  -> return AgentToolResult
```

Tool names should be stable. Tool arguments and results should be JSON-shaped
and versionable.

## Reference Tool Sets

Tenon should use nodex as the outliner reference and a proven local-tool runtime
as the local tool reference. Tenon should still keep its own lower snake case tool
names because the runtime, permission model, and UI are Tenon-owned.

nodex tools:

- `node_create`
- `node_read`
- `node_edit`
- `node_delete`
- `node_search`
- `undo`
- `browser`

nodex is the closest outliner reference. Its important lesson is that document
tools should be domain-specific, not generic file operations. The agent edits
nodes through outliner verbs and each write is undoable as one AI operation.
Tenon should keep nodex's compact `node_*` surface, but use Tenon's own final
contracts from `agent-tool-design.md`: `node_create.outline`,
`node_read(...)`, `node_edit.old_string/new_string`, and `past_chats` for raw
prior conversation spans. The parser is implemented in TypeScript rather than
left as prompt-only behavior. Compatibility normalization belongs in the
adapter/runtime layer and should not appear in the model-facing tool
description. Tenon code should use neutral parser names such as
`lin_outline_parser`.

Reference local and agent tool roles:

- shell execution
- file read, edit, write, glob, and grep
- web fetch and web search
- task planning
- skill invocation
- user question
- delegated child-run execution
- bash stop
- plan mode
- MCP resource listing and reading

The reference runtime is useful for tool contracts, permission checks, and tool
pool filtering. For local tools, Tenon should copy the role boundaries,
descriptions, argument schemas, and model-visible action payloads where they fit.
Runtime details can keep Tenon's common `ToolResult` envelope, but
`node_*` model-visible output should use the discriminated node protocol from
`agent-tool-design.md` rather than exposing the envelope directly:

The bridge to pi-agent-core must remain native: tool `execute` returns
`AgentToolResult` content/details only, while Tenon's shared `afterToolCall`
adapter maps envelope errors (`details.ok === false`) to
`ToolResultMessage.isError = true`.

- Dedicated file tools should be preferred over shell commands.
- `file_read` is the freshness prerequisite for `file_edit` and existing-file `file_write`.
- `file_edit` is exact string replacement, not a custom patch protocol.
- `file_glob` finds paths; `file_grep` searches contents.
- `bash` runs commands and can background long-running work.
- `bash_stop` only stops a background task; it is not a generic process manager.
- Large command output should be persisted and then read through the file tool.

Tenon configures a local `ask_user_question` tool for structured clarification.
The runtime persists pending question events, exposes the pending question to the
renderer, and resumes the blocked tool call when the user submits an answer or
chooses the dedicated `discussed` outcome. Answer inputs use the same structured
node-ref, local-file-ref, and attachment model as the main composer; path-backed
answer attachments still pass through the realpath-based local-root jail and
materialization path before they are persisted in `user_question.answered`.
Web access is covered by `web_search` and `web_fetch`.

## Tenon Tool Registry

Tenon uses a compact, stable tool registry. Higher-risk tools should still be
added only after approval, rendering, and undo behavior are solid.

The detailed tool contract, parameter schema, and result envelope are defined in
`docs/spec/agent-tool-design.md`. This document only describes how those tools
fit into the pi-mono runtime.

### P0 Tools

These are the active core tool surface.

| Tool | Reference | TypeScript-backed? | Permission notes | Purpose |
|---|---|---:|---|---|
| `node_search` | nodex `node_search`, Tenon search-node outline | Yes | Default allow | Execute a temporary or saved search node outline without mutating document state. |
| `node_read` | nodex `node_read` | Yes | Default allow | Read node raw type/data, fields, and bounded children. |
| `node_create` | nodex `node_create`, Tenon outline parser | Yes | Default allow unless blocked | Create outline trees, references, search/view nodes, schema nodes, or duplicates. |
| `node_edit` | nodex `node_edit`, Tenon outline parser | Yes | Default allow unless blocked | Edit a known node's annotated outline by exact replacement, or perform explicit move, merge, or reference replacement. |
| `node_delete` | nodex `node_delete` | Yes | Default allow unless blocked | Trash or restore nodes. |
| `outline_undo_stack` | nodex `undo`, Tenon history | Yes | Default allow unless blocked | List, undo, or redo user and agent outline operations. |
| `file_read` | local file read role | Yes | Typed file boundary | Read files with bounded output and freshness tracking. |
| `file_glob` | local file glob role | Yes | Typed file boundary | Find files by path pattern. |
| `file_grep` | local file grep role | Yes | Typed file boundary | Search file contents with bounded output. |
| `file_edit` | local exact edit role | Yes | Typed file boundary | Perform exact string replacement after reading the file. |
| `file_write` | local file write role | Yes | Typed file boundary | Create files or rewrite whole files. |
| `file_delete` | local file delete role | Yes | Typed file boundary | Move files or directories to agent trash. |
| `bash` | shell execution role | Yes | Hard redlines + soft blocks | Run local commands with timeout, block policy, and output limits. |
| `bash_stop` | bash stop role | Yes | Default allow unless blocked | Stop background commands created by `bash`. |
| `web_search` | web search role | Optional | Default allow unless host/offline policy blocks | Search the web for current external information. |
| `web_fetch` | web fetch role | Optional | Default allow unless host/offline policy blocks | Fetch and read a specific URL with pagination or snippet search. |
| `generate_image` | image generation role | Yes | Default allow unless blocked | Generate or edit raster images through enabled image-capable providers and store generated image files. |

P0 intentionally follows nodex's compact outliner surface instead of exposing
one tool per UI command. Tag, field, reference, move, and merge behavior
belong inside `node_create` and `node_edit` semantics, not separate `node_tag`,
`node_field`, or `node_move` tools.

### P1 Agent Tools

These agent-level tools are active on top of the P0 local/document surface.

| Tool | Reference | TypeScript-backed? | Approval | Purpose |
|---|---|---:|---|---|
| `past_chats` | local conversation/run logs | Yes | No | Search/read visible prior chats and exact raw source spans. |
| `ask_user_question` | structured user elicitation | Yes | No | Pause a run for single-choice, multi-choice, free-text, refs/attachments, or a discuss-before-answering outcome. |
| `skill` | local skill invocation | Yes | Usually no | Invoke installed or built-in skills; `/skillify` is the built-in user- and model-invocable authoring workflow. |

`bash_stop` is active because Tenon's `bash` tool supports background commands.

### P2 Tools

These should wait until the product needs them.

| Tool | Reference | TypeScript-backed? | Approval | Purpose |
|---|---|---:|---|---|
| `browser` | nodex `browser` | Yes | Usually yes | Control an embedded browser tab if Tenon adds one. |
| `mcp_list_resources` | MCP resource discovery | Yes | No | Discover MCP resources. |
| `mcp_read_resource` | MCP resource reading | Yes | No | Read MCP resources. |
| `mcp_call_tool` | MCP tool calls | Yes | Depends | Call configured MCP server tools. |
| `todo_write` | task planning | No | No | Maintain internal task plans if agent planning needs a tool. |
| `skill` | skill invocation | Partly | Depends | Load and invoke local skill folders. |
| `sub_agent` | child agent execution | Mixed | Depends | Spawn child agents. Not needed for Tenon v1. |

Do not configure browser, MCP, or sub-agent tools in the first release unless
there is a specific user-facing workflow. A larger tool pool increases prompt
cost and makes permission behavior harder to reason about.

## Tool Naming

Tenon should use lower snake case tool names for all Tenon-owned tools:

- `node_*` for document graph operations.
- `file_*` for filesystem operations.
- `bash` for shell execution.
- `bash_stop` for stopping background commands created by `bash`.
- `node_search` / `node_read` for durable timeline memory nodes.
- `past_chats` for visible prior conversation history and exact raw source spans.
- Runtime-owned Dream runs are private `memory-dream` skill runs in the protected
  Dream channel. Scheduled Dream is at most once per daily due, and Settings can
  trigger a manual run that uses the same same-day `#d-memory` container. They
  read raw conversation spans since the Dream watermark when sources exist;
  manual consolidate-only runs can reconcile outline/prior Dream context without
  new chat spans. The Dream channel itself rejects ordinary chat messages, is
  forced out of Dream evidence, and does not contribute prior active-path
  transcript to later Dream model context. They gather
  relevant prior memory/workspace context via `node_search` / `node_read`, apply
  the human-dream cycle and valuable-memory filter, and — when the filter leaves
  memory worth writing — write `#d-*` memory nodes (`#d-episode`, `#d-belief`,
  optional `#d-question`, optional `#d-guidance`) with selective `[[chat:...]]`
  provenance when citation improves auditability or disambiguation, and may delete
  obsolete nodes with `node_delete`. A run that finds nothing worth remembering
  writes nothing, and a clean run records `dream.completed` (advancing the
  watermark) and writes a reflective run meta entry either way. A run cut off
  mid-work by an unresolved context overflow is flagged `incomplete`; if it also
  wrote nothing it is treated as a failure — no `dream.completed`, watermark
  unchanged — so the span is retried. There is no `/dream`
  slash command and no foreground `dream` tool.
- `web_search` / `web_fetch` for web access.
- `generate_image` for raster image generation and editing through provider
  image capabilities.

Do not use:

- legacy `Read` / `Edit` / `Write` aliases: Tenon should make the local
  capability explicit with lower snake case names.
- generic mutation tools such as `outliner_write`, `outliner_apply_patch`, or
  `node_batch`: they force the model to learn a second mini-protocol and make
  permission boundaries less clear.

The current implementation configures the P0 tools and the P1 agent tools listed
above. Additional tools should be added by product need, not because a reference
project has them.

## TypeScript Tool Commands

Electron main handlers should be the only place where local side effects happen.

Expected command families:

```txt
agent_tool_node_search
agent_tool_node_read
agent_tool_node_create
agent_tool_node_edit
agent_tool_node_delete
agent_tool_outline_undo_stack
agent_tool_file_read
agent_tool_file_write
agent_tool_file_edit
agent_tool_file_glob
agent_tool_file_grep
agent_tool_bash
agent_tool_bash_stop
agent_tool_web_search
agent_tool_web_fetch
agent_tool_generate_image
```

Each command should receive:

- `conversationId`
- `runId`
- `toolCallId`
- normalized tool arguments
- active tab context if relevant

Each command should return:

- `ok`
- structured `data` when successful
- structured `error` when failed
- optional `preview` for UI rendering
- optional `operation` with `undoGroupId` for document mutations
- optional `requiresApproval` for deferred execution

`generate_image` returns normal tool-envelope details plus short
scratch-relative local paths for each generated image. Runtime details keep the
actual provider/model used for UI and debug display, but the model-visible JSON
contains only paths, `markdownImage`, and file metadata needed for follow-up
work. The raw image bytes are written to the app-owned generated-image
directory under the agent scratch root and are not copied into model-visible
JSON, renderer debug text, or extra image content blocks. When the user should
see the images, the assistant places each returned `markdownImage` string in the
final response; this is standard Markdown image syntax with a `file:^...`
local-file target. The renderer loads the bytes through the trusted local preview
bridge. The tool
result details are persisted with the event and are the renderer's source for
generated image paths. If a generated file is later cleared, path preview surfaces
keep the image slot and show an unavailable-image placeholder; if the agent
reuses a missing generated path or file marker as an edit input, `generate_image`
returns `input_image_unavailable` before calling the provider.

TypeScript should validate paths, workspace boundaries, command timeouts, output size,
and mutation legality. TypeScript validation is useful for fast feedback, but it
is not the security boundary.

## Permission Flow

Tool permissions use the default-allow blocklist gate in
`agent-tool-permissions.md`. Ordinary local and external work runs immediately.
Hard redlines deny before execution. Built-in or user soft blocks pause the run
with an allow-once / always-allow / block card; unattended soft blocks deny
without waiting.

Flow:

```txt
Tool call starts
  -> adapter asks TypeScript for descriptors and blocklist classification
  -> if allowed, tool runs immediately
  -> if soft-blocked, AgentRuntime appends approval.requested and waits
  -> user allows once, always allows, blocks, or countdown auto-blocks
  -> AgentRuntime appends approval.resolved and tool.permission.resolved
  -> adapter resolves tool result
  -> pi-agent-core continues
```

Rejected, auto-blocked, hard-blocked, or unattended soft-blocked tools return a
normal tool result that says permission was denied. The agent can then explain
or propose a safer alternative.

## Event Mapping

pi-mono events should be normalized into Tenon events before they reach storage,
debug, or renderer components. The canonical event-store architecture lives in
`docs/spec/agent-event-log-rendering.md`.

Currently emitted event categories:

- `conversation.created`
- `conversation.renamed`
- `payload.created`
- `debug.run_snapshot.created`
- `branch.selected`
- `user_message.created`
- `user_message.edited`
- `assistant_message.started`
- `assistant_message.delta`
- `assistant_message.completed`
- `tool_call.started`
- `tool_call.completed`
- `tool_call.failed`
- `tool_result.created`
- `run.started`
- `run.completed`
- `run.failed`

Schema-reserved categories for the next runtime passes:

- `assistant_message.failed`
- `thinking.delta`
- `tool_call.delta`
- `approval.requested`
- `approval.resolved`
- `follow_up.queued`
- `follow_up.applied`
- `run.cancelled`
- `compaction.completed`
- `payload.derived`
- `checkpoint.created`

The raw pi-mono event can be kept as a payload ref for debugging, but UI
components should render from Tenon's normalized render projection.

This keeps the transcript renderer independent from pi-mono and makes future
migration to a TypeScript agent core or another library possible.

## State Persistence

Agent conversations are not workspace tabs. They belong to shell-level agent
state.

Persist the Agent Session Event Store:

- Append-only normalized events.
- Payload files referenced by event payload refs.

Represent these product facts as events:

- Conversation metadata changes.
- User and assistant message lifecycle.
- Branch selection.
- Tool call and tool result lifecycle.
- Approval lifecycle when approval UI/runtime pause is enabled.
- Run status.
- Model/provider id used for each run.
- References to applied document undo groups.
- Compaction and checkpoint availability.

Do not persist:

- API keys.
- Full shell output when it is huge.
- Full file contents unless required for conversation fidelity.
- Chain-of-thought or hidden reasoning.
- Transient approval promises.

Restoring a conversation rebuilds projections from the event store. When
execution starts, derive the active-path pi-ai `Message[]` through the adapter
and hydrate the underlying pi-agent-core `Agent`.

## Abort And Steering

Abort should be available whenever a run is active.

Abort behavior:

- Abort the model stream.
- Ask active tool commands to cancel if they support cancellation.
- Mark the run as cancelled.
- Keep completed messages and tool results immutable.

Steering uses pi-agent-core's steering queue in the current runtime. If the user
sends a new instruction while the agent is streaming, Tenon queues it as steer
input for the active run instead of starting an unrelated run in the same
conversation.

Examples:

- "Stop editing files, just explain the plan."
- "Use the active node instead."
- "Do not run bash."

Follow-up remains a separate queue for work that should run after the current
run stops naturally. Persisted `follow_up.*` events are reserved for a later
pass; current queued follow-up and steer state are runtime state.

## Context Compaction

Tenon should treat compaction as a product policy, not as a library detail.
Compaction is active in the runtime and has three entry points:

- manual `/compact [instructions]`
- proactive auto compact before a model call when estimated context crosses the configured threshold
- reactive compact after a provider context-length error, followed by a retry

Use cases:

- Conversation grows beyond model context.
- Tool outputs are large.
- The user switches from local file work back to outliner work.

Runtime strategy:

1. Persist single large tool outputs immediately after tool execution and send the model a fixed `<persisted-output>` preview.
2. Before each model call, enforce a per-tool-batch aggregate budget for fresh tool results only.
3. Never retroactively replace already-seen unreplaced tool results; that would change a cached prefix.
4. Time-based microcompact may clear old compactable tool results when the cache is expected to be cold.
5. Auto/reactive compact uses the same no-tools summary path as manual compact.
6. If the summary request itself hits a provider context limit, retry by dropping the oldest API-round groups before giving up.
7. Reactive compact preserves the latest user/tool tail after the compact root so the retry continues from the same pending work.
8. After compacting, restore recently read full text files within a bounded budget and reset file-edit freshness to only those restored files.
9. When deduplicating restored files against the preserved reactive tail, treat `file_unchanged` results as stubs, not as visible file content.

**Slimming targets the model copy, not the canonical record.** The per-batch budget
offload (2) and the time-based microcompact (4) emit `tool_result.replaced`, but that
event writes a separate `modelSlimmedContent` on the tool-result record instead of
overwriting `content`. Model-context derivation (`runtimePiMessageFromRecord`,
`agentEventMessageToPiMessage`, the per-batch sizing in `collectToolResultBatches`,
and Dream memory extraction — every consumer reading via `modelFacingContent`)
substitutes `modelSlimmedContent` when present; the UI
transcript and the search index keep reading the full `content`, so an old
`web_search` / `web_fetch` result never decays into an input-only / no-output row. The
`tool_result.replaced` event remains the durable, monotonic slim-decision journal —
replaying it never shrinks the canonical content, so a result is never un-slimmed
(cache-stable) and slim-decision logic reads the model-facing copy
(`modelSlimmedContent ?? content`) so an offloaded/cleared result is never re-emitted.
This is the Claude Code 2.1 stance: slim the model's per-request copy, keep the
persisted transcript full. The >50K immediate persist in (1) is the exception — it
records the preview ref in the record at creation, before any full content ever
entered the transcript.

Large persisted tool outputs should follow the stable agent-runtime pattern: keep the full
output outside the transcript, record a fixed preview/reference string in the
message, and never re-decide or silently expand that payload during resume.

After compaction, use the Agent wrapper to replace the underlying pi-mono
messages. Persist both the compacted message and enough metadata to explain that
older context was summarized.

## Error Handling

Errors should be explicit and recoverable.

Model errors:

- Authentication failure.
- Rate limit.
- Context overflow.
- Provider unsupported tool call.
- Stream interruption.

Tool errors:

- Invalid arguments.
- Permission denied.
- Approval rejected.
- Path outside workspace.
- Command timeout.
- Output truncated.
- Document conflict.

Every tool error should be returned to the model as a tool result, not thrown
past the agent loop unless the runtime itself is broken. Runtime failures should
mark the run as failed and leave the transcript readable.

## Local Security

The local agent is powerful because it can edit files, run commands, and mutate
the outliner. TypeScript must enforce the boundary.

Baseline rules:

- Restrict typed file tools to the configured local file root unless the user
  explicitly hands a broader folder to Tenon.
- Normalize and canonicalize paths in TypeScript.
- Enforce command timeout and output limits.
- Redact known secret patterns from tool output where possible.
- Hard-block catastrophic operations and let users add narrower block rules from
  the permission log for repeated unwanted behavior.
- Group document mutations into undoable transactions.
- Never let a renderer-only check be the final permission check.

## Implementation Status

Landed in main:

- pi-mono dependencies are pinned and isolated behind Tenon's Electron main
  runtime boundary.
- `AgentRuntime` owns session lifecycle, prompt routing, stop/reset/branch
  commands, pi-agent-core subscriptions, provider debug capture, event append,
  projection emission, and checkpoint writes.
- `useLinAgentRuntime` consumes Tenon-owned `AgentRuntimeEvent` /
  `AgentRenderProjection` data instead of pi-mono objects.
- Agent conversations persist through the event store, not through mutable
  pi-agent-core state.
- Active-path pi-ai `Message[]` is derived from replay state when a session is
  restored or a new run starts.
- Web, outliner, file, bash, and background-task tools execute through Tenon's
  TypeScript main-process gateway.
- Large tool output and provider request/response debug data use event-store
  payload refs.
- Session list, search, user-message history, debug history/totals, and
  checkpoints are derived from the event store.
- Provider authentication spans pi-ai's three credential classes: a single
  non-throwing `getProviderApiKey` resolver (api-key / OAuth auto-refresh-persist
  / env / managed), chmod-600 local credential storage, and a main-owned OAuth
  sign-in flow (loopback + device-code) bridged to a renderer sign-in UI.

Remaining runtime work:

- Approval UI/runtime pause flow for risky tools.
- Persisted follow-up events.
- Performance metrics around replay, projection, IPC payload size, and long
  transcript rendering.
- Richer lazy media previews for non-text payloads in render/debug details.
- More explicit cancellation events once pi-agent-core abort semantics are mapped
  cleanly to Tenon's `run.cancelled`.

## Testing

Current coverage should stay focused on the Tenon-owned boundary:

- Event schema, replay, active path, branch selection, pi-ai message derivation,
  render projection, event store append ordering, checkpoint replay, corrupt
  checkpoint recovery, index rebuild, payload refs, and large-session behavior.
- Run-grounded debug derivation (`agentDebugView`) from per-run streams + the
  `debug.run_snapshot.created` provider-request capture.
- Tool argument validation, local path boundaries, bash timeout/output caps,
  node tool behavior, web tool normalization, and tool-result envelope mapping.
- Renderer runtime hydration, projection events, branch actions, streaming view
  state, and payload-backed copy behavior.
- Provider credential resolver (api-key, OAuth refresh-persist, env/managed
  fallback, never-throws, chmod-600 storage), OAuth login orchestration (callback
  bridging, reply correlation, cancel, logout), and the renderer OAuth flow
  reducer / expiry formatters.
- E2E coverage for composer controls, model/settings behavior, process/tool
  disclosure, debug panel, virtualization, bounded large-output rendering, and
  provider OAuth sign-in (device-code, loopback, connected, sign-out).

Next coverage should land with the corresponding runtime features:

- Approval pause/resume/reject flow.
- Persisted follow-up events.
- Compaction events and pi-mono message replacement.
- Explicit `run.cancelled` mapping.
- Performance metric event emission and analysis views.

## Migration Risk

Using pi-mono should not make Tenon dependent on pi-mono forever.

Keep these interfaces stable:

- Tenon-owned `AgentEvent`.
- Tenon-owned `AgentRuntimeEvent`.
- Tenon-owned `AgentRenderProjection`.
- Tenon-owned tool schemas and result envelopes.
- Tenon-owned Electron IPC command payloads.
- Tenon-owned persisted conversation schema.

If Tenon later moves to a TypeScript agent core, the replacement should only need to
implement the runtime adapter contract. Document tools, Electron IPC commands,
permissions, transcript rendering, and persistence should remain mostly intact.

## Summary

pi-mono should provide the agent brain: model abstraction, streaming, agent
loop, tool-call orchestration, and steering.

Tenon should provide the local body: outliner operations, file operations, bash,
permissions, approvals, undo, persistence, and UI state.

This split gives Tenon a fast path to a capable local agent without giving up
control over the local-first TypeScript core.
