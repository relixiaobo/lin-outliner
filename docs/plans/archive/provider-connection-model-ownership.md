# Provider Connection and Agent Model Ownership

## Goal

Make provider configuration connection-only, and move model / reasoning ownership
to the agent identity that actually runs.

The current UI leaks an old global-provider model into two places:

- Provider config asks the user to choose `Model` and `Thinking level`, even
  though the provider row should only prove credentials and endpoint reachability.
- The composer shows the active model chip in a DM / channel, even though the user
  is talking to an agent identity or a channel roster, not directly to a model.

The result is misleading in both directions: users can think a provider has one
global model, and in channels the composer can imply a single model even when
multiple agents may answer with different profiles.

## Non-goals

- Do not redesign agent context composition or firmware layering. That belongs to
  `agent-context-architecture` (#254).
- Do not add conversational agent authoring. That belongs to
  `conversational-agent-authoring` (#251).
- Do not implement per-message model switching from the chat surface.
- Do not expose provider-specific raw effort strings as free-form user input.

## Design

This is shape **(a)**: one complete feature in one PR. It is not useful to ship
only one side. Provider config cannot drop `modelId` until the built-in assistant
has a real default-model home, and the composer cannot hide the model chip until
that default is available outside the provider row.

### 1. Providers own connection, not model choice

`AgentProviderConfig` becomes a connection record:

- `providerId`
- optional `baseUrl`
- `enabled`
- auth state remains in the existing secret / OAuth / managed provider paths

It should not require or semantically own `modelId` or `reasoningLevel`.

The provider config window becomes:

- credential or provider-specific auth instructions
- Base URL where relevant
- `Test connection`
- Save / cancel / remove provider

Known catalog providers do not show a model picker in the provider window.
Custom OpenAI-compatible providers also should not ask for a model just to save
the provider; if a model is needed for a probe, the runtime should discover or
choose it internally.

### 2. Validation proves reachability with an internal probe model

`agentTestProviderConnection` validates connection, not a user-selected model.

Probe order:

1. Use a known provider catalog model chosen by the runtime, preferably the first
   ranked model after the existing model-ranking sort.
2. For OpenAI-compatible custom endpoints, try a model-listing probe first when
   the adapter supports it.
3. If a completion probe is still required, use the first discovered model.
4. If no model can be discovered, return an honest connection error that says the
   endpoint was reached but no usable model was found.

The probe should keep today's bounded behavior: short timeout, tiny output budget,
and cancellable UI state. The UI copy should say `Test connection`, not imply it
is validating a chosen model.

### 3. Agent profile owns model and effort

The model and reasoning/effort selector belongs to the agent profile that will
run:

- User / project agents keep using `AgentDefinition.model` and
  `AgentDefinition.effort`.
- The built-in assistant needs an app-level editable profile/default-model slot
  because built-in definitions are read-only. Add this to settings-owned
  profile/default storage that is separate from provider config.

The selector is capability-driven:

- Select provider first, then model.
- Effort options are derived from the selected model's supported thinking levels.
- If the model supports no reasoning, hide the effort control or show only `Off`.
- If the user changes to a model that does not support the old effort, coerce to
  the closest supported level through one shared helper.

Persist canonical values from the adapter capability surface, not display labels.
For example, UI may display `Max`, but the saved/submitted value must be whatever
the selected model actually accepts (`xhigh`, `max`, or another adapter-owned
canonical value). The current hard-coded `AgentReasoningLevel` union should not be
treated as the whole product model if provider adapters expose narrower or
different official names.

### 4. Composer stops showing model identity

The composer footer should not render the model chip in DM or channel mode.

Keep model/provider visibility in surfaces where it is diagnostic or
configuration-relevant:

- agent profile settings
- message details popover
- run/debug panel
- ledger metadata

The composer can still show attachments, send controls, approval state, and
channel addressing affordances. It should not present model identity as a primary
conversation control.

### 5. Runtime resolution reads agent-owned config

Runtime model resolution becomes:

1. Resolve the active usable provider connection.
2. Resolve the running agent's model selection:
   - user/project agent override if present
   - built-in assistant default profile setting
   - catalog fallback only as a last-resort first-run default
3. Resolve model capabilities and coerce effort for that model.
4. Build the provider model object with the provider connection's auth/base URL.

This preserves message/run metadata: assistant events still record actual
`providerId`, `modelId`, usage, and thinking level for Details/debug.

### 6. Storage and compatibility

Pre-release cleanup rule applies. No migration or legacy reader is required for
dev data. The implementation may normalize old provider rows by ignoring old
`modelId` / `reasoningLevel` and seeding the built-in assistant default from the
active provider's previous values on first read if that is cheaper than wiping
dev userData during manual verification.

## Files likely touched

- `src/core/types.ts`
- `src/main/agentSettings.ts`
- `src/main/agentRuntime.ts`
- `src/renderer/api/client.ts`
- `src/renderer/ui/agent/ProviderConfigWindow.tsx`
- `src/renderer/ui/agent/ProviderConfigForm.tsx`
- `src/renderer/ui/agent/AgentComposer.tsx`
- `src/renderer/ui/agent/AgentComposerControls.tsx`
- `src/renderer/ui/agent/AgentEditor.tsx`
- `src/renderer/ui/agent/AgentSettingsView.tsx`
- `src/renderer/ui/agent/settingsReasoning.ts`
- `src/core/i18n/messages/en.ts`
- `src/core/i18n/messages/zh-Hans.ts`
- `docs/spec/agent-event-log-rendering.md`
- `docs/spec/agent-delegation-runtime.md`
- `docs/spec/agent-pi-mono-implementation.md`
- `docs/spec/design-system.md`
- provider settings / runtime / composer tests

`src/core/types.ts` is a shared protocol surface, so the implementation PR should
call this out explicitly and keep the schema change narrow.

## Collision self-check

Checked open PR claims on 2026-06-15:

- #254 `agent-context-architecture` is plan-only and touches
  `docs/plans/agent-context-architecture.md`.
- #252 `agent-permission-redesign` touches Settings UI broadly, but its scope is
  permission model / security settings, not provider config ownership.
- #251 `conversational-agent-authoring` is plan-only and touches
  `docs/plans/conversational-agent-authoring.md`.

No direct file-scope conflict for the plan itself. The implementation PR may have
nearby Settings UI overlap with #252 if both are active; re-check before coding.

## Review gate

This is plan-track because it changes user-visible settings behavior and touches
the provider/runtime contract.

Recommended gate for the implementation PR:

- `/code-review ultra` because it touches provider/runtime config and shared
  types.
- UI visual verification in light and dark for provider config, agent profile,
  DM composer, and channel composer.
- Run `bun run typecheck`, relevant core/renderer tests, provider settings e2e,
  and `bun run docs:check`.

## Open questions

1. Should the built-in assistant default model live in `AgentRuntimeSettings`, or
   should built-in agent definitions get an editable overlay record keyed by
   `agentId`?
   Recommendation: use an overlay keyed by `agentId` if #254 wants built-ins to
   remain immutable definitions; use `AgentRuntimeSettings` only if the app has
   exactly one built-in default to configure.
2. For custom OpenAI-compatible endpoints that do not support model listing, do we
   allow an optional advanced `Probe model` field?
   Recommendation: defer. First try connection-only validation and return a clear
   error if the endpoint cannot advertise a model.
3. Should the composer show the agent/profile name where the model chip used to
   be?
   Recommendation: no for DM, because the header already names the conversation
   target. Revisit only for channel-specific addressing if the footer needs a
   roster control.
