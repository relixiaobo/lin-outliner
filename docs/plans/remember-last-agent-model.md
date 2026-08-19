# Remember The Last Agent Model

## Goal

New root conversations reuse the last execution selection that the user
successfully saved in the Agent composer. Saving happens immediately when the
user chooses a model or reasoning effort; it does not wait for a message, Turn,
or model request. The remembered selection includes the provider, model, and
reasoning effort, survives an app restart, and applies to creation from both the
conversation list and `/new`. A later explicit provider action in Settings
supersedes the composer memory, so the last explicit action wins.

This is one complete feature in one PR.

## Non-goals

- Do not change existing Thread configurations.
- Do not change fork inheritance, Automation model selection, provider
  activation, or Configuration Profile capability ceilings.
- Do not add renderer-owned model persistence or extend the Agent Core protocol.
- Do not make an unavailable remembered selection block Thread creation.

## Design

### Preference ownership

Store the most recent successful root execution selection in
`app-preferences.json` alongside the other app-level UI preferences. Decode the
field through the Agent protocol's `ThreadConfigurationSummary` decoder, plus a
bounded persisted-string limit. Missing, partial, malformed, oversized, and
provider/model-mismatched values become `null` without affecting other
preferences. The same validation runs before a value is written.

`ThreadCatalogOps.setThreadConfiguration` remains the atomic write authority.
After validation and the canonical Thread configuration update both succeed, it
immediately notifies an optional `ThreadService` host callback with the committed
summary only for an active, persistent root user Thread. Archived and ephemeral
Thread edits remain local. The Electron main composition root uses that callback
to save the preference before any message or model request is needed. The hook
may be asynchronous, but preference persistence is best effort and cannot turn a
committed Thread update into a renderer-visible failure.

An explicit Settings provider action clears the remembered selection after it
succeeds: setting an active provider, disabling a provider, or deleting a
provider. Startup reconciliation also clears it when reconciliation moves the
persisted active-provider pointer. The next root Thread therefore follows
Settings/Profile defaults until another composer selection establishes new
memory.

### New Thread defaults

Make the internal `RendererThreadStartDefaults` result an exclusive choice
between an active provider default and a complete remembered execution
selection. A request-aware helper resolves the remembered choice only when no
provider or Configuration Profile was explicitly requested and all of these
remain true at creation time:

- the remembered provider is still usable;
- the remembered model still resolves for that provider; and
- the remembered reasoning effort is still supported by that model.

When valid, `ThreadCatalogOps.startThread` resolves the ordinary default
Configuration Profile first, then replaces only its model and reasoning effort
while using the remembered provider for the root Thread. Tools, Skills, plugins,
MCP servers, developer instructions, and all capability ceilings continue to
come from the fresh Profile snapshot. An explicitly requested Configuration
Profile retains its own pinned model and reasoning effort and uses the active
provider path instead of composer memory.

When the preference is absent, provider lookup rejects, or the selection is no
longer valid, creation follows the existing active-provider and Profile-default
path. The stale preference is harmless and a later successful composer selection
replaces it. Explicit host starts that already provide a provider and working
directory do not consume this renderer preference.

Child Agents keep their existing configuration resolution. Consequently, a
child Role with no model or reasoning override inherits the remembered root
Thread's effective model and effort, just as it inherits any other explicit root
selection.

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
- `falls back to active provider when remembered provider lookup rejects`
- `preserves an explicit Configuration Profile instead of applying memory`
- `remembers configuration only from active persistent root user Threads`

Run `bun run typecheck`, the focused Core tests, `bun run test:core`,
`bun run docs:check`, and `git diff --check`.

## Files

- `src/main/appPreferences.ts`
- `src/main/main.ts`
- `src/main/agent/rendererThreadStartDefaults.ts`
- `src/main/agent/capabilities/agentSettings.ts`
- `src/main/agent/ThreadService.ts`
- `src/main/agent/thread/ThreadCatalogOps.ts`
- `src/core/agent/codec.ts`
- `tests/core/appPreferences.test.ts`
- `tests/core/rendererThreadStartDefaults.test.ts`
- `tests/core/agentProviderReconcile.test.ts`
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
- Letting composer memory override an explicit Profile or a later Settings action
  would make those controls lie. Request-aware resolution and explicit
  invalidation preserve last-action ownership.

## Collision Result

`gh pr list`, `docs/TASKS.md`, and active-plan scope show no conflicting hunk or
symbol. PR #564 merged during the build and changed no implementation file in
this scope. Open PR #565 overlaps on `src/main/main.ts` and
`src/main/agent/ThreadService.ts`: its Agent identity writer, persona resolver,
and command registrations are disjoint from this change's app preference import,
provider actions, renderer-start defaults, and configuration commit hook. No
infrastructure-ownership file or Agent Core protocol surface is involved.

## Open Questions

None.
