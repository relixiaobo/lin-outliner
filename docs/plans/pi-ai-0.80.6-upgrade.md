# pi-ai / pi-agent-core 0.80.3 -> 0.80.6 upgrade

Tenon pins `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` at
exact versions. This change upgrades both packages from `0.80.3` to `0.80.6`
and adopts the current upstream reasoning-level contract, including the new
independent `max` level.

This is shape **(a): one complete feature in one PR**. The PR upgrades the
runtime packages, exposes every reasoning level currently returned by pi-ai,
and verifies the existing provider/runtime integration against the new
catalog and streaming behavior.

## Goal

- Upgrade both pi packages to exact version `0.80.6`.
- Preserve Tenon's `Models`-based provider and credential adapter.
- Expose `max` end to end as a distinct reasoning level after `xhigh`.
- Adopt upstream runtime fixes for truncated tool calls, context budgeting,
  retries, OAuth polling, reasoning replay, and provider error reporting.
- Refresh the built-in model catalog without retaining removed model entries.

## Non-goals

- No migration, compatibility reader, or fallback catalog for removed model
  ids. Tenon has not shipped and has no user data to preserve.
- No aliasing `max` onto `xhigh`; they are separate persisted values.
- No adoption of pi-agent-core's optional harness session-storage APIs.
- No new reasoning-token or cost-reporting UI. Existing usage and cost
  projections continue to consume pi-ai's calculated totals.
- No renderer theme or layout redesign.

## Design

### Reasoning levels

Extend Tenon's shared reasoning contract with `max`:

- append `max` to `AgentReasoningLevel` and `AGENT_REASONING_LADDER`;
- add localized display copy for the canonical level;
- allow settings/profile validation, skill effort overrides, runtime state,
  composer controls, and agent editing to persist and dispatch `max`;
- keep provider/model-specific display labels authoritative when pi-ai
  supplies a `thinkingLevelMap` value;
- preserve the order returned by Tenon's shared ladder, with `max` after
  `xhigh`;
- keep `medium` as the default and use the existing nearest-supported-level
  rule when a model does not support it.

`getSupportedThinkingLevels(model)` remains the catalog authority. Tenon must
not discard `max` when projecting a model into `AgentModelOption`.

### Package upgrade

Update the exact dependencies and lockfile entries:

- `@earendil-works/pi-ai`: `0.80.3` -> `0.80.6`;
- `@earendil-works/pi-agent-core`: `0.80.3` -> `0.80.6`.

No provider SDK versions change in this release range. Product runtime calls
continue through `src/main/piModels.ts`, and `pi-agent-core` continues to
receive Tenon's explicit `streamFn`.

### Runtime behavior

Use the upstream behavior directly rather than duplicating it in Tenon:

- tool calls from `length`-truncated assistant messages fail without
  executing and the loop can ask the model to reissue them;
- `streamSimple()` caps output against the remaining context window and
  ignores stale usage before a compaction boundary;
- retry classification covers explicit retry responses, Cloudflare 524,
  Bun socket drops, and gRPC resource exhaustion;
- OpenAI/Codex/Anthropic reasoning replay and empty signed thinking blocks
  retain provider continuity;
- GitHub Copilot device-code polling honors initial delay and server-provided
  slowdown intervals.

Tenon's event log and tool lifecycle adapter should accept these events using
the existing contracts. Add product-side code only if verification exposes a
real adapter mismatch.

### Model catalog

Use the `0.80.6` generated catalog as current truth. New models and metadata
surface through the existing provider settings projection and ranking. Removed
upstream ids are not reintroduced locally, and no persisted-data migration is
added.

### Specification

Update `docs/spec/agent-pi-mono-implementation.md` in the same change with:

- the exact pinned versions;
- the complete reasoning ladder through `max`;
- the upstream-owned truncated-tool-call and context-budget behavior;
- the clean-cut catalog rule for this pre-release application.

## Open questions

None. The PM confirmed that `max` must not be filtered and that no user-data
compatibility work is required before release.

## Files

Expected product and documentation surface:

- `package.json`
- `bun.lock`
- `src/core/types.ts`
- `src/core/agentReasoning.ts`
- `src/core/i18n/messages/en.ts`
- `src/core/i18n/messages/zh-Hans.ts`
- `src/main/agentSettings.ts`
- `src/renderer/ui/agent/AgentEditor.tsx`
- reasoning/provider/runtime unit and E2E tests as needed
- `docs/spec/agent-pi-mono-implementation.md`

`src/core/types.ts` and the two i18n files overlap open PR #386. This branch is
an isolated claim; main must choose merge order and the later branch must
rebase. No open PR currently overlaps the package files, pi adapter, or pi
implementation spec.

## Risks

- The generated catalog changes model availability, ordering, context windows,
  and pricing metadata.
- `max` is a shared protocol addition and must be handled by every reasoning
  selector and validator, not only the provider settings screen.
- `0.80.6` is newly published, so packaged provider loading and full agent E2E
  behavior require verification beyond typechecking.
- Open PR #386 may merge first and require a small conflict resolution in the
  shared protocol/i18n files.

## Verification

- `bun run typecheck`
- `bun run test:core`
- `bun run test:renderer`
- `bun run docs:check`
- `bun run app:build`
- focused agent provider, OAuth, model/effort, and runtime E2E tests
- `bun run test:e2e`

## Checklist

- [ ] Add `max` to the shared reasoning contract and every selector/validator.
- [ ] Add core and renderer coverage for independent `xhigh` and `max` values.
- [ ] Upgrade both pi packages and refresh `bun.lock`.
- [ ] Verify provider catalog, OAuth, custom endpoints, streaming, and tool
      lifecycle behavior.
- [ ] Fold the shipped behavior into the pi implementation spec.
- [ ] Run full verification and record exact results in the PR.
