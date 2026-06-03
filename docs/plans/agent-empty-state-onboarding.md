---
status: draft
priority: P1
owner: relixiaobo
created: 2026-06-03
updated: 2026-06-03
---

# Agent Panel: Empty State + No-Provider Onboarding

## Goal

Fix the agent panel's empty/initial state (PM decisions #5 + #6):

- **E1 — Remove the suggested-prompt chips.** The three hardcoded starter
  prompts ("总结当前大纲", "规划 agent 接入阶段", "列出下一步工具设计") are
  redundant; remove them. Replace with a simple greeting or clean whitespace —
  keep it minimal.
- **E2 — No-LLM-key onboarding.** When no usable provider/API key is configured,
  the panel currently gives no guidance: the model button is disabled
  ("No model configured") but the send button is still clickable and the message
  only errors at runtime. Add an onboarding state that guides the user to
  Settings › Providers and disables send.

## Non-goals

- Building the provider sign-in flow (that's `agent-oauth-providers.md`).
- Changing provider detection logic in core/main; this is renderer empty-state
  + send-guard only.
- Persisting or i18n-ing the greeting copy (hardcode for now; the rest of the
  app is English per repo policy — see open questions on the greeting language).

## Design

### E1 — Remove suggestion chips

`AgentChatPanel.tsx` defines `SUGGESTED_PROMPTS = [...]` and renders them in the
`entries.length === 0` branch as `.agent-suggestion` buttons. Delete the array
and the render block. When the conversation is empty AND a provider is
configured, render either:

- a minimal greeting (e.g. a single muted line), or
- nothing (clean whitespace above the composer).

Recommend a one-line muted greeting for warmth, kept to a single neutral string.

### E2 — No-provider onboarding

Provider availability is already computed in `AgentChatPanel.tsx`:
`getActiveProvider(settings)` returns null when no provider has
`hasApiKey || hasEnvApiKey || catalog.hasEnvApiKey` (`providerCanUseModels`).

- **Empty state when no usable provider:** instead of the greeting/chips, render
  an onboarding card: a short line ("Connect an AI provider to start") + a CTA
  button that opens Settings › Providers. Reuse the existing settings-open path
  (the sidebar footer / `onOpenSettings` already opens the Settings window; route
  to the Providers category).
- **Disable send:** `AgentComposer.tsx` `canSubmit` does not check provider
  availability, so send fires and errors at runtime. Add a guard: when no usable
  provider, `canSubmit = false` and the send button shows a tooltip pointing to
  Settings. Thread an `hasUsableProvider` boolean (derived in `AgentChatPanel`)
  into `AgentComposer`.
- **Model button tooltip:** already "No model configured" — optionally make it
  actionable ("Add a provider in Settings") and open Settings on click.

This composes cleanly with E1: empty conversation → if no provider, show
onboarding; if provider present, show greeting/whitespace.

## Open questions

1. **Greeting copy + language.** A greeting is user-facing chat chrome. Repo
   policy writes everything in-repo in English, but the app UI elsewhere shows
   mixed CN/EN. Use an English greeting? (Recommend English for consistency with
   the rest of the chrome; confirm with PM.)
2. **Onboarding CTA target.** Open the Settings window directly on the Providers
   category — confirm the existing settings-open API can deep-link to a category,
   or if it just opens Settings (then user clicks Providers).
3. **Greeting vs whitespace.** Single muted line, or fully blank? (Recommend a
   single line.)

## Files (scope)

`src/renderer/ui/agent/AgentChatPanel.tsx` (remove chips, add empty/onboarding
state), `src/renderer/ui/agent/AgentComposer.tsx` (send-guard + tooltip),
possibly a small CSS tweak for the onboarding card. No core/protocol surface.

## Checklist

- [ ] Delete `SUGGESTED_PROMPTS` + its render block.
- [ ] Empty state w/ provider: minimal greeting / whitespace.
- [ ] Empty state w/o provider: onboarding card + CTA → Settings › Providers.
- [ ] `AgentComposer` send-guard when no usable provider; tooltip → Settings.
- [ ] `bun run typecheck` + `test:renderer`.
- [ ] Light + dark visual gate (UI change), both with and without a key.
