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
- Persisting or i18n-ing the greeting copy (hardcode a single English string).

## Design

### E1 — Remove suggestion chips

`AgentChatPanel.tsx` defines `SUGGESTED_PROMPTS = [...]` and renders them in the
`entries.length === 0` branch as `.agent-suggestion` buttons. Delete the array
and the render block. When the conversation is empty AND a provider is
configured, render either:

a single muted **English** greeting line (kept to one neutral string).

### E2 — No-provider onboarding

Provider availability is already computed in `AgentChatPanel.tsx`:
`getActiveProvider(settings)` returns null when no provider has
`hasApiKey || hasEnvApiKey || catalog.hasEnvApiKey` (`providerCanUseModels`).

- **Empty state when no usable provider:** instead of the greeting/chips, render
  an onboarding card: a short line ("Connect an AI provider to start") + a CTA
  button that opens Settings › Providers. Reuse the existing settings-open path
  (the sidebar footer / `onOpenSettings` opens the Settings window) and
  **deep-link to the Providers category** (PM-ratified: the CTA lands directly on
  Providers, not the generic Settings root).
- **Disable send:** `AgentComposer.tsx` `canSubmit` does not check provider
  availability, so send fires and errors at runtime. Add a guard: when no usable
  provider, `canSubmit = false` and the send button shows a tooltip pointing to
  Settings. Thread an `hasUsableProvider` boolean (derived in `AgentChatPanel`)
  into `AgentComposer`.
- **Model button tooltip:** already "No model configured" — optionally make it
  actionable ("Add a provider in Settings") and open Settings on click.

This composes cleanly with E1: empty conversation → if no provider, show
onboarding; if provider present, show greeting/whitespace.

## Decisions (PM-ratified 2026-06-03)

- **Greeting:** show a single muted **English** greeting line when the
  conversation is empty and a provider is configured (not blank whitespace).
- **Onboarding CTA deep-links** to Settings › **Providers** category.

## Review findings (codex pre-review, 2026-06-03 — verified against `main`, folded in)

All five confirmed against current code; resolutions baked into the Design / Checklist.

- **Gate onboarding on LOADED state, not just "no provider" (P2).** `providerSettings`
  starts `null` and loads async (`AgentChatPanel.tsx:517`, effect ~597). A naive
  `!getActiveProvider(providerSettings)` would flash the no-provider onboarding (and
  disable send) for key-holding users during the load window. **Rule:** show onboarding /
  apply the no-provider send-guard ONLY when settings are loaded (`providerSettings !==
  null`) AND no usable provider exists; while loading, stay neutral (no onboarding card,
  no provider-axis send-disable).
- **Extract ONE usable-provider helper first (P2).** `getActiveProvider` +
  `providerCanUseModels` are duplicated verbatim in `AgentChatPanel.tsx:80/88` and
  `AgentComposer.tsx:1198/1236`, and `providerCatalog.tsx:155` already has
  `resolveUsableActiveProvider`. Consolidate to a single renderer helper (reuse/extend
  `resolveUsableActiveProvider`) and replace both copies BEFORE wiring empty-state +
  send-guard, so empty state, composer, and Settings read one source. **Anticipate oauth
  #93's `authKind`** (it adds OAuth / managed-credential to `core/types.ts`): the "usable"
  predicate must generalize beyond `hasApiKey || hasEnvApiKey` to also count signed-in
  OAuth / resolved managed credentials — so it isn't copy-pasted a fourth time.
- **CTA deep-link needs no new scope (P2) — resolves the old open question.**
  `window.lin.openSettings()` (`preload/index.ts:119` → main `lin:open-settings`,
  `main.ts:602`) takes no category, BUT the Settings window defaults to the Providers
  category, so the CTA already lands on Providers. No preload/main change required. (A
  category param would be separate scope if ever wanted.)
- **Disabled send needs an explicit reason prop (P3).** `AgentComposerPrimaryAction`
  (`AgentComposerControls.tsx:145`) only takes `canSubmit` and hard-codes
  `title="Send"`/`"Steer agent"`; `canSubmit=false` alone gives no no-provider reason. Add
  a `disabledReason`/`disabledTitle` prop so the disabled tooltip reads "Add a provider in
  Settings."
- **Add e2e for the user-visible behavior (P3).** The default e2e mock always has a key
  (`tests/e2e/outlinerMock.ts:216 hasApiKey: true`). Add a no-provider mock variant and
  cover: onboarding renders + CTA invokes `openSettings` + click/Enter does NOT fire
  `agent_send_message`; with-provider shows the greeting + sends normally.

**Collision:** oauth PRs #92 (plan, draft) / #93 (interface-first — `core/types.ts` +
`core/commands.ts`, adds `authKind`; ready). No direct file overlap, but the shared
usable-provider helper above is the conceptual seam — extract it with the `authKind`
dimension in mind and coordinate with the oauth work so the predicate has one home.

## Open questions

- Resolved: settings-open deep-link (see review findings — `openSettings()` lands on
  Providers by default; no category param needed).

## Files (scope)

- `src/renderer/ui/agent/providerCatalog.tsx` — promote/extend `resolveUsableActiveProvider`
  into the single usable-provider helper (anticipate `authKind`).
- `src/renderer/ui/agent/AgentChatPanel.tsx` — drop duplicated `getActiveProvider`/
  `providerCanUseModels`; remove chips; add loaded-gated empty/onboarding state.
- `src/renderer/ui/agent/AgentComposer.tsx` — drop its duplicated helpers; thread
  `hasUsableProvider` + loaded-state into the send-guard.
- `src/renderer/ui/agent/AgentComposerControls.tsx` — add `disabledReason`/`disabledTitle`
  to `AgentComposerPrimaryAction`.
- `tests/e2e/outlinerMock.ts` + a no-provider e2e spec; possibly a small CSS tweak for the
  onboarding card. No core/protocol surface (oauth #93 owns the `authKind` types).

## Checklist

- [ ] Extract/reuse one usable-provider helper (`providerCatalog.tsx`); replace the two
  duplicated copies in `AgentChatPanel` + `AgentComposer`. Generalize for `authKind`.
- [ ] Delete `SUGGESTED_PROMPTS` + its render block.
- [ ] Empty state w/ provider: minimal greeting / whitespace.
- [ ] Empty state w/o provider (settings LOADED only): onboarding card + CTA → Settings ›
  Providers (existing `openSettings()`).
- [ ] `AgentComposer` send-guard when loaded && no usable provider; `disabledReason`
  tooltip → Settings (do NOT disable during the load window).
- [ ] `bun run typecheck` + `test:renderer`.
- [ ] e2e: no-provider variant (onboarding + CTA + no `agent_send_message` on click/Enter)
  and with-provider (greeting + sends).
- [ ] Light + dark visual gate (UI change), both with and without a key.
