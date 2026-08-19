# Remember The Last Agent Model

## Goal

New root conversations reuse the last execution selection that the user
successfully saved in the Agent composer. Saving happens immediately when the
user chooses a model or reasoning effort; it does not wait for a message, Turn,
or model request. The remembered selection includes the provider, model, and
reasoning effort, survives an app restart, and applies to creation from both the
conversation list and `/new`.

This is one complete feature in one PR.

## Non-goals

- Do not change existing Thread configurations.
- Do not change fork inheritance, child Agent configuration, Automation model
  selection, provider activation, or Configuration Profile capability ceilings.
- Do not add renderer-owned model persistence or extend the Agent Core protocol.
- Do not make an unavailable remembered selection block Thread creation.

## Design

### Preference ownership

Store the most recent successful root execution selection in
`app-preferences.json` alongside the other app-level UI preferences. Decode the
field defensively as either a complete `ThreadConfigurationSummary` or `null`;
missing, partial, malformed, and empty values become `null` without affecting
other preferences.

`ThreadCatalogOps.setThreadConfiguration` remains the atomic write authority.
After validation and the canonical Thread configuration update both succeed, it
immediately notifies an optional `ThreadService` host callback with the committed
summary. The Electron main composition root uses that callback to save the
preference before any message or model request is needed. Preference persistence
is best effort and cannot turn a committed Thread update into a renderer-visible
failure.

### New Thread defaults

Extend the internal `RendererThreadStartDefaults` result with an optional
remembered execution selection. The main composition root resolves it only when
all of these remain true at creation time:

- the remembered provider is still usable;
- the remembered model still resolves for that provider; and
- the remembered reasoning effort is still supported by that model.

When valid, `ThreadCatalogOps.startThread` resolves the ordinary Configuration
Profile first, then replaces only its model and reasoning effort while using the
remembered provider for the root Thread. Tools, Skills, plugins, MCP servers,
developer instructions, and all capability ceilings continue to come from the
fresh Profile snapshot.

When the preference is absent or no longer valid, creation follows the existing
active-provider and Profile-default path. The stale preference is harmless and a
later successful composer selection replaces it. Explicit host starts that
already provide a provider and working directory do not consume this renderer
preference.

The renderer continues to issue the same `thread/start` request. Both the list
action and `/new` already share that path, so there is no second creation flow or
protocol field to keep synchronized.

### Specification and verification

Update `agent-thread-rendering.md` to state that a new root conversation reuses
the last successfully committed execution selection across launches, with
availability validation and fallback to current defaults.

Add focused tests with these titles or equivalent behavior:

- `persists the last Agent Thread execution selection`
- `ignores an invalid persisted Agent Thread execution selection`
- `starts a renderer-owned Thread with the remembered execution selection`
- `keeps fresh Profile capabilities when applying the remembered execution selection`
- `does not report preference persistence failure as a configuration failure`

Run `bun run typecheck`, the focused Core tests, `bun run test:core`,
`bun run docs:check`, and `git diff --check`.

## Files

- `src/main/appPreferences.ts`
- `src/main/main.ts`
- `src/main/agent/ThreadService.ts`
- `src/main/agent/thread/ThreadCatalogOps.ts`
- `tests/core/appPreferences.test.ts`
- `tests/core/agentThreadService.test.ts`
- `docs/spec/agent-thread-rendering.md`

## Risks

- Copying the whole prior effective configuration would retain stale capability
  policy. The overlay is deliberately limited to model and reasoning effort.
- A removed model or disabled provider could make Thread creation fail. The
  preference is revalidated and discarded for that creation before admission.
- A preference callback failure occurs after the canonical SQLite commit. It is
  isolated as best-effort persistence so the user never receives a false failure
  for a configuration that already changed.

## Collision Result

`gh pr list`, `docs/TASKS.md`, and active-plan scope show no conflicting hunk or
symbol. PR #564 merged during the build and changed no implementation file in
this scope. Open PR #565 overlaps only on `src/main/main.ts`: its Agent identity
writer imports and command registrations are disjoint from this change's app
preference import and Thread-service options. No infrastructure-ownership file
or Agent Core protocol surface is involved.

## Open Questions

None.
