# Model-First Model Picker

## Goal

Make model selection **model-first**: one flat list of models across every
connected provider, provider demoted to a secondary label, and a selectable
default row that keeps the Thread on the newest model of its connection.

The saved value stays the canonical `providerId/modelId` (or the existing
`inherit` sentinel) that `core/agentModelId` already defines, so this is a
renderer/UX change with no protocol, persistence, or main-process work.

## Non-goals

- **No protocol or data-model change.** `ThreadConfigurationSummary`
  (`modelProvider` / `model` / `reasoningEffort`) is untouched.
- **No main-process change.** Model ranking and runtime resolution already exist
  and are consumed as-is.
- **No cross-provider late binding.** A Thread stays on its connection; the
  default row floats the *model*, never the *provider*. Making the provider hop
  late-bound would require changing `resolveDefaultRuntime`
  (`src/main/agent/runtime/PiTurnExecutor.ts`) and is deliberately out of scope.
- **Automation `Inherit` semantics stay as they are.** Its empty option means
  "override nothing" (`null` provider *and* `null` model) and must keep meaning
  that; see D3.
- **Provider setup is untouched.** Connection UX is `anthropic-auth-clarity`'s
  subject, not this plan's.
- **The file-preview translation model picker is untouched.** Same data shape,
  different surface, not in scope.

## Background: what the code actually does today

The board entry names `AgentEditor` / `AgentModelEffortSelector`. Neither exists —
the per-profile editor was removed when the product collapsed to a single agent
(#300), which means the Provider + Model Override merge the board asks for has
already happened by deletion. Two provider-first surfaces remain:

- `src/renderer/agent/components/ThreadComposerModelControl.tsx` — the composer
  quick-switcher. Its model submenu groups by provider and renders the **raw**
  `providerId` as the group heading (`:296-298`), so `openai-codex` and
  `cc-switch-codex` appear verbatim as section titles. The grouping is suppressed
  entirely when only one provider is usable, so single-connection users already
  see a flat list.
- `src/renderer/agent/automations/AutomationEditor.tsx` — a native `<select>`
  with `<optgroup label={providerId}>` (`:269-271`).

Two behaviors matter for the design:

1. **The pill already shows a resolved concrete model name.** With
   `configuration.model === 'inherit'` (the built-in profile default,
   `AgentConfigurationLoader.ts:30`), `parseProviderQualifiedModel` returns
   `null` — `inherit` carries neither a `/` nor a `:` qualifier — so
   `deriveModelMenu` falls back to `modelsFor(providerId)[0]`.
2. **Because of that same fallback, floating is indistinguishable from pinned,
   and is a one-way door.** The check mark lands on the newest model whether the
   Thread is on `inherit` or explicitly pinned to that model, and the menu only
   ever offers concrete models, so `selectModel` can never write `inherit` back.
   Once a user picks a model, that Thread stops following new releases and there
   is no way back.

Fixing (2) is the substance of this change.

## Design

### D1 — The default row: "Always newest"

A first row in the model list commits only the model field:

```ts
commit({ ...configuration, model: 'inherit' })
```

`modelProvider` is deliberately **not** written. The row therefore means "always
use the newest model on this connection", which is literally true whether one or
many providers are connected, and needs no qualifying copy in either case.

Leaving `modelProvider` alone is always well-defined: every renderer-started
Thread already carries a concrete, usable provider —
`resolveRendererStartDefaults` (`src/main/main.ts:546-550`) takes it from
`getActiveProviderRuntimeConfig()` and throws when no provider is configured.

Not hopping the provider also avoids an outright defect: because
`PREFERRED_PROVIDER_ORDER` ranks `anthropic` first, a row that resolved its own
provider would silently move a Thread already running on OpenAI over to
Anthropic. It further keeps that hand-maintained table out of execution
semantics — it orders a list and nothing more.

**Selected state.** Introduce an explicit floating predicate rather than
inferring it from the resolved id:

```ts
const floating = !configuration.model.trim() || configuration.model.trim() === 'inherit';
```

- `floating` → the check mark is on the default row; concrete rows are unchecked.
- otherwise → the check mark is on the row matching the parsed
  `providerId/modelId`.

The pill keeps showing the resolved concrete name in both states; only check-mark
placement changes. The default row carries that resolved name as secondary text,
so "newest" is never abstract.

### D2 — One flat, cross-provider list

A new `src/renderer/ui/agent/modelChoices.ts` flattens usable providers and their
models into a single ordered `ModelChoice[]`, and is consumed by both surfaces so
the two stop deriving menus independently.

- **Within a provider:** catalog order, untouched. `providerModelOptions`
  (`agentSettings.ts:735`) already sorts by `compareProviderRankables`, so models
  arrive at the renderer best-first.
- **Across providers:** the Thread's current provider first, then usable
  providers (`isProviderUsable`) by `preferredProviderIndex`, then display name.
  Version numbers are **never** compared across providers — `claude-opus-4-8`,
  `gpt-5.2`, and `gemini-3.5` produce version tuples with no meaningful ordering
  between them.
- **Provider label:** rendered inline as secondary text through
  `formatProviderName`, and only when more than one provider is usable. Never a
  group heading, never a raw `providerId`.
- **Truncation:** the existing per-provider top-N cap and `Show all (N)`
  expander are preserved, and the current selection stays visible when it falls
  outside the cap (`visibleModels`).

### D3 — Automation editor

Drop `<optgroup>`; render flat `<option>`s labelled `<model> · <Provider>` when
more than one provider is usable. The empty option keeps its `Inherit` label and
its exact current semantics.

This is presentation-only on purpose. The empty option writes `''`, which
`nullable` (`:492-493`) stores as `null` for **both** `modelProvider` and
`model`, and `assertAutomationConfigurationMatchesThread`
(`AutomationDispatcher.ts:280-282`) skips its consistency check on `null`.
Relabelling it "always newest" would pin a provider *and* arm that assertion, so
an Automation saved today would fail at dispatch once its destination Thread's
provider diverged. "Override nothing" is a distinct, useful capability and is
kept distinct.

### D4 — What "newest" is ranked by

Nothing new is introduced; two existing authorities are reused.

- **Within a provider:** `src/main/modelRanking.ts` `compareModels` — product
  line, then version descending, then reasoning, then clean alias over dated
  snapshot, then id. Its only hand-maintained input is `MODEL_LINES`, which is
  version-independent; an unrecognized product line is caught by
  `findUnknownLineModels` under an existing guard test rather than silently
  sinking.
- **Across providers:** `PREFERRED_PROVIDER_ORDER` — ordering only, per D1.

The UI and the runtime resolve through the same source: `resolveProviderModel`
→ `resolveProviderCatalogModel` → `rankedModels(providerId)[0]`
(`agentModelResolution.ts:113-124`) is the same ranked head the renderer reads at
index 0. The name shown as "always newest" is therefore the model that actually
executes.

### D5 — Visual

Reuse the existing `.thread-composer-model-*` ladder; add one class for the
inline provider label. Selection, hover, and open states keep the neutral
`--fill-*` ladder and neutral focus ring (B3); no box on icon affordances (B6);
hover changes no layout (B7); no `cursor: pointer` (B10). Both themes verified.

## Verification

- **Main — the real invariant:** the first entry of `providerModelOptions` equals
  the model `resolveProviderModel` resolves for that provider. This belongs in
  main, not the renderer: the renderer merely reads index 0, so a renderer-side
  assertion compares one array to itself and would stay green if main's sort and
  the runtime's resolution ever diverged — exactly the drift that would make the
  UI name a model that does not run. Importing `src/main/modelRanking.ts` from a
  renderer test would also cross the process seam (A2).
- **Renderer unit:** `modelChoices` ordering and provider-label suppression, plus
  floating-vs-pinned check-mark placement.
- **E2E** (`tests/e2e/agent-thread.spec.ts`): the reworked menu structure, and a
  pin-a-model-then-return-to-always-newest round trip — the reversibility this
  change exists to add.
- `bun run typecheck`, `test:core`, `test:renderer`, `test:e2e`, `docs:check`.
- UI gate: light + dark visual verification.

## Open questions

- Whether multi-connection Threads should eventually float across providers as
  well. That needs a main-side fallback in `resolveDefaultRuntime` and is a
  separate, independently shippable change.
