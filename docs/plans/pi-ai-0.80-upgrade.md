# pi-ai / pi-agent-core 0.78 → 0.80.2 upgrade

We pin `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` at exact
`0.78.0` (`package.json:33-34`, both direct deps). npm latest is **0.80.2**
(released 2026-06-23). The gap (0.78.1 → 0.79.0–0.79.10 → 0.80.0–0.80.2) carries
a large batch of provider/model-metadata fixes (GPT-5.4/5.5 + Codex
context-window **billing-hazard** corrections, Gemini/GLM-5.2/Kimi/DeepSeek
metadata), streaming-robustness fixes, vulnerable-dependency bumps (`undici`,
`protobufjs` — 0.79.8), and feature work we mostly don't consume (TUI themes,
`pi update` flow).

A full surface audit (0.80.2 tarball `.d.ts` diffed against the real 0.78.0
tarball, not changelog prose) shows the **only breaking change that touches us**
is **v0.80.0**, which moved the old global pi-ai API off the package root to the
`@earendil-works/pi-ai/compat` subpath. Six functions we import from the root
moved; everything else we use is unchanged. This is therefore a **small,
behavior-preserving** upgrade.

This is shape **(a): one complete feature in one PR** — version bump + import
migration + verification land together. The deeper migration to pi-ai's new
`createModels()` provider-factory API is an explicit **non-goal** here (separate
future plan).

## Goal

Move both packages to `0.80.2` and adapt our imports so the app type-checks,
tests green, and the agent actually runs (chat round-trip, model picker, OAuth
login) — picking up the upstream provider-metadata and security fixes with the
smallest, lowest-risk change.

## Non-goals

- **No migration to `createModels()` / `builtinModels()` / the new `auth`
  `CredentialStore` model.** `/compat` is a strict superset of the old root API
  (same signatures, same return types), and pi-agent-core 0.80.2 *itself* still
  imports `@earendil-works/pi-ai/compat` internally — so `/compat` is load-bearing
  at this version and will not vanish underneath us. We take the `/compat` path
  now; the factory migration is a tracked follow-up for when upstream removes
  compat (it is documented as eventually-removed "with the coding-agent
  ModelManager migration"). See *Open questions*.
- **No change to our credential storage.** Our `agent-secrets.json`
  `ApiKeyCredential = { type: 'api_key'; key: string }` (`agentSettings.ts:81`)
  is **our own** type; we never read/write pi's `auth.json`. The 0.80.2 pi
  `auth.json` discriminator change (`type: "api-key"` → `"api_key"`) does not
  reach us. (Coincidentally our discriminator already matches.)
- No new provider wiring, no protocol/`src/core` change, no UI change.

## Design

### What actually breaks (the whole surface)

Six **value (runtime)** functions we import from the `@earendil-works/pi-ai`
**root** moved to `/compat` in 0.80.0. They appear in **three files**:

| Moved symbol | Files importing it from root |
|---|---|
| `getModels` | `agentSettings.ts`, `agentRuntime.ts` |
| `getProviders` | `agentSettings.ts`, `agentRuntime.ts` |
| `completeSimple` | `agentSettings.ts`, `agentRuntimeContext.ts`, `agentRuntime.ts` |
| `streamSimple` | `agentRuntime.ts` |
| `getEnvApiKey` | `agentSettings.ts` |
| `findEnvKeys` | `agentSettings.ts` |

**The fix:** split each of those three `import { … } from '@earendil-works/pi-ai'`
statements into two — moved symbols from `@earendil-works/pi-ai/compat`, the rest
unchanged from the root. No call-site logic changes: the `/compat` aliases
`getModels`/`getProviders` keep the exact 0.78 return types (`Model[]` /
`KnownProvider[]`), and `completeSimple`/`streamSimple` keep the exact
`(model, context, options?: SimpleStreamOptions)` signature.

### What does NOT change (verified still on root / subpath, signatures stable)

- **pi-ai root value imports that stay:** `getSupportedThinkingLevels`,
  `isContextOverflow`, `cleanupSessionResources`,
  `createAssistantMessageEventStream`.
- **All pi-ai type imports stay on root:** `Api`, `KnownProvider`, `Model`,
  `OAuthProviderId`, `SimpleStreamOptions`, `AssistantMessage`, `ImageContent`,
  `TextContent`, `Message`, `ToolCall`, `ToolResultMessage`, `UserMessage`,
  `ThinkingContent`, `Usage`, `AssistantMessageEventStream`, `OAuthCredentials`,
  `OAuthLoginCallbacks`, `OAuthProviderInterface`.
- **`@earendil-works/pi-ai/oauth` subpath stays:** `getOAuthApiKey`,
  `getOAuthProvider` still exported there.
- **All of pi-agent-core stays on root, unchanged:** `Agent` (value) +
  `AgentTool`, `AgentToolResult`, `AfterToolCallResult`, `AgentEvent`,
  `AgentLoopTurnUpdate`, `StreamFn`. `AgentOptions` is byte-for-byte identical
  between 0.78 and 0.80.2.
- We use **none** of the per-provider subpaths (`pi-ai/anthropic`,
  `pi-ai/openai-*`, …) that 0.80.2 collapsed into `pi-ai/providers/*` — verified
  by grep, no occurrences.

### Concrete edits

1. **`package.json:33-34`** — bump both to `0.80.2` (still exact pins). Run
   `bun install`; review the `bun.lock` diff for the bumped transitive SDKs
   (`@anthropic-ai/sdk`, `openai`, `@google/genai`, `@mistralai/mistralai`,
   `@aws-sdk/client-bedrock-runtime`).
2. **`src/main/agentSettings.ts`** — `findEnvKeys`, `getEnvApiKey`, `getModels`,
   `getProviders`, `completeSimple` → `/compat`; keep `getSupportedThinkingLevels`
   on root.
3. **`src/main/agentRuntimeContext.ts`** — `completeSimple` → `/compat`; keep
   `isContextOverflow` on root.
4. **`src/main/agentRuntime.ts`** — `completeSimple`, `getModels`, `getProviders`,
   `streamSimple` → `/compat`; keep `getSupportedThinkingLevels`,
   `isContextOverflow`, `cleanupSessionResources`,
   `createAssistantMessageEventStream` on root.

That is the entire code change.

### Bundling note

`electron.vite.config.ts` externalizes only `electron`, so both packages (and
their provider SDKs) are bundled into the main-process bundle. pi-agent-core
0.80.2 internally imports `@earendil-works/pi-ai/compat`; that subpath is in
0.80.2's `exports`, so Rollup resolves it (contrast the recent `foliate-js`
breakage, which was a missing install, not a missing export). `bun run app:build`
must still be run to confirm the bundle.

## Risks (low)

- **Behavioral drift in surviving symbols.** Type shapes were verified stable but
  not every field byte-diffed; `AgentEvent` may have gained additive union
  variants (our `switch` needs a `default`). 0.79–0.80 shipped many streaming
  fixes (encrypted `reasoning_details`, tool-call delta ordering, OpenAI Responses
  null-content tolerance) — generally compatible, but the streamed-transcript path
  is the thing to regress-test on a real run.
- **Transitive SDK bumps** pulled in by 0.80.2 (anthropic/openai/google/mistral/
  aws) increase bundle size and could shift runtime behavior; inspect the lock
  diff.
- **`/compat` is temporary.** Acceptable now (load-bearing via pi-agent-core), but
  recorded as a follow-up so we don't get stranded when it's removed.

## Verification (green tests ≠ can chat)

- `bun run typecheck`
- `bun run test:core` + `bun run test:renderer`
- `bun run test:e2e`
- **Real run** (`bun run dev:main`): one full chat round with Neva (exercises
  `completeSimple`/`streamSimple` streaming + the model picker's
  `getModels`/`getProviders`), and one OAuth provider login (exercises
  `getOAuthApiKey`). The agent store/unit tests do not cover the runtime session
  lifecycle.
- `bun run app:build` — confirm the packaged bundle resolves
  `pi-ai/compat` and launches.
- `bun run docs:check`.

## Open questions

- **Now-or-later on the factory migration.** Default: ship `/compat` now, open a
  separate `pi-ai-createModels-migration` plan later (rewrite the catalog builder
  in `agentSettings.ts` onto `builtinModels()`/`Models` and adopt the new `auth`
  model). Confirm we don't want to do the factory migration in this same PR
  (recommendation: no — keep this upgrade small and reviewable).

## Collision check

- `gh pr list` empty (no open PRs); `docs/TASKS.md` scan + grep of the three
  target files against open-PR scopes: no overlap. Touches `package.json`
  (infra-ownership — coordinate the bump as its own commit) + three `src/main/`
  agent-runtime files. No protocol/`src/core` change.

## Checklist

- [ ] Bump `package.json:33-34` both → `0.80.2`; `bun install`; review `bun.lock` diff.
- [ ] Split imports in `agentSettings.ts` (5 moved → `/compat`).
- [ ] Split imports in `agentRuntimeContext.ts` (`completeSimple` → `/compat`).
- [ ] Split imports in `agentRuntime.ts` (4 moved → `/compat`).
- [ ] Add a `default` guard wherever we `switch` on `AgentEvent` if not already present.
- [ ] `bun run typecheck` + `test:core` + `test:renderer` + `test:e2e`.
- [ ] Real run: chat round-trip + model picker + OAuth login.
- [ ] `bun run app:build` launches.
- [ ] `/code-review` (+ `/security-review` — touches OAuth/credential paths).
