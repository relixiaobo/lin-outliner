# Agent Execution Selection Settings

**Shape:** (a) ONE complete feature in one PR. The configuration ownership
cutover, Settings UI, spawn resolution, persisted child snapshot, model-tool
contraction, specifications, and regression coverage ship together.

## Goal

Make child-Agent model selection a user-owned runtime setting instead of part of
the model-visible `agent` tool or an Agent Role definition. Every collaboration
Agent type starts in **Follow parent** mode. A user may configure an available
provider/model and reasoning effort for a built-in or custom Agent type in
Settings; a fresh child resolves that setting over its direct parent's effective
selection and persists the resulting snapshot.

After the cutover, adding models to a provider catalog does not lengthen the
`agent` tool schema, the delegating model cannot choose a different model for a
child, and editing an Agent's instructions or capabilities cannot accidentally
rewrite its execution selection.

## Non-goals

- No change to the root conversation's composer model control or Configuration
  Profile. Root Threads remain directly user-configurable through their existing
  model and reasoning controls.
- No per-Agent service tier, token budget, timeout, permission profile, or
  personality setting. These need separate ownership and product decisions.
- No conversion of `run_in_background`, `execution`, `isolation`, or context
  selection into standing preferences. They describe an individual delegated
  task or a Host safety boundary and remain task-local.
- No change to Role capability narrowing. Tools, Skills, plugins, and MCP servers
  remain definition-owned ceilings and keep their existing Settings controls.
- No execution override for isolated Skills. They are not collaboration Agent
  types and retain their existing invocation-owned configuration.
- No blocking prompt when a saved explicit model becomes unavailable. Runtime
  fallback is automatic and visible; changing the standing setting remains a
  deliberate user action.
- No migration or compatibility decoder for pre-cutover Role model fields or
  child override columns. Reset pre-release Agent userData and remove the old
  reader shape.

## Design

### Separate definition from execution selection

`AgentRole` continues to own dispatch identity, description, developer
instructions, presentation, and capability narrowing. Remove `model` and
`reasoningEffort` from `AgentRoleOverrides`; neither field is accepted inside a
Role after the clean cut.

Each user/project configuration layer gains an `agentExecution` map keyed by the
canonical model-visible Agent type (`general-purpose`, `explore`, `plan`, or a
custom Role name). One row may contain:

```json
{
  "modelProvider": "openai",
  "model": "openai/example-model",
  "reasoningEffort": "high"
}
```

`modelProvider` and provider-qualified `model` are one optional pair;
`reasoningEffort` is independently optional. An absent field means inherit that
field from the direct parent, an absent row means inherit the complete selection,
and an empty row is removed rather than persisted. The provider field must match
the provider prefix of the model identity. A project row replaces the same user
row as one entry, matching Role and presentation layering; fields never merge
across layers.

The execution map is keyed by canonical Agent type rather than backing Role. The
hidden `default`, `explorer`, and `plan` Role names therefore never leak into the
UI or acquire a second setting identity. Deleting a custom Role removes its
same-layer execution row in the same atomic write, so recreating the name cannot
silently recover a stale model choice. A custom Role's execution row must live in
that Role's layer; only built-in Agent types may independently choose the user or
project layer. When both layers define a same-name custom Role, only the
execution row beside the winning project Role is effective; it never inherits
the shadowed user Role's row.

### Settings experience

Settings -> Agent -> Agents adds an **Execution** group to every collaboration
Agent editor, including the three built-ins and custom Roles. The conversation
agent (`main`) keeps its existing root-Thread controls and does not show this
group.

The Model popup starts with **Follow parent**, followed by language models from
enabled, credentialed providers in the existing provider catalog. Reuse
`buildModelChoices` ordering, provider labels, and provider-qualified identities
instead of creating another catalog or hard-coded model list. A saved selection
that is no longer available remains visible as unavailable until the user chooses
a valid model or Follow parent; opening and saving another field never deletes it.
Main validates a newly selected row against the current provider catalog before
writing it. An unchanged saved row that later became unavailable remains
round-trippable, so provider churn cannot make unrelated identity or definition
edits destructive. The Agents list and editor mark that row **Unavailable** and
state that new runs will follow their parent until the user changes the setting.

The Reasoning popup starts with **Follow parent**. With an explicit model, it
offers only that model's supported canonical levels. With an inherited model it
may retain an explicit canonical level, but the Host validates the resulting pair
against the actual parent model at spawn. Selecting Follow parent for both fields
removes the execution row.

One Save remains one validated atomic file edit. Role writes and built-in
presentation writes carry execution selection as a sibling payload rather than
nesting it in the Role/presentation draft. The returned `AgentEditorView` contains
the stored execution rows separately from definitions and identity presentation.
The Settings page receives the already-loaded `AgentProviderSettingsView` from
`AgentSettingsView`; it does not issue its own provider request or import a model
catalog into the renderer. Settings shows the standing selection, while the
existing Trajectory projection remains the authority for the provider/model that
an actual Turn used; transcript headers do not gain duplicate runtime metadata.

### Fresh-spawn resolution and lifecycle

After resolving `subagent_type` to its canonical Agent type, a collaboration
spawn reads that type's merged execution row using the parent's cwd. Resolution
is field-wise:

1. use the configured provider/model pair when present, otherwise the direct
   parent's effective provider/model;
2. use the configured reasoning effort when present, otherwise the direct
   parent's effective effort; and
3. validate the complete provider, model, credential availability, and supported
   effort before worktree preparation, execution-ledger admission, child Thread
   creation, or provider I/O; and
4. if a formerly valid explicit selection is now unavailable or incompatible,
   use the direct parent's complete provider/model/reasoning selection for this
   spawn and record why the fallback occurred.

Parent validation resolves the usable provider connection first and delegates
model validation to the runtime resolver, so an arbitrary model ID already used
successfully through a custom OpenAI-compatible endpoint remains inheritable
without appearing in the provider catalog.

Fallback is visible but never blocks the Turn. The child starts normally and its
launch/report surface shows one persistent, non-modal warning: the configured
model was unavailable and this run followed the parent. The warning offers an
**Open Agent Settings** action for that canonical Agent type. It survives
transcript reload, is not duplicated by terminal notifications, and does not put
raw credentials or provider errors in the renderer. Settings retains the saved
unavailable row until the user explicitly chooses another model or Follow parent.

The fallback fact and the requested display identity are durable execution
provenance, while the child's effective configuration records only what actually
ran. The warning is also returned as structured tool guidance so the delegating
model knows the child is running under fallback; the parent Turn continues and
must not fabricate a spawn failure. If the parent's own selection cannot start a
new request, the spawn fails promptly with an actionable provider error, creates
no child artifacts, and leaves the parent Turn able to continue.

Malformed configuration still fails closed at the file decode/write boundary.
Availability drift is a runtime condition and degrades under A12; an
already-running Turn is never killed by a later settings or catalog change.

The fresh child stores the effective `modelProvider` on its Thread and the
effective model/reasoning values in its immutable `EffectiveThreadConfiguration`.
Resume and parent-message continuation reuse that snapshot and never re-read the
setting. A later Settings change affects only a new Agent identity. Nested Agents
apply the same rule against their direct parent, so an unset nested type inherits
the model that actually runs its parent.

Remove the persisted `modelOverride` and `reasoningEffortOverride` bookkeeping
from child Thread metadata. The effective configuration is the single replay and
recovery authority; retaining both the source override and the resolved snapshot
would allow them to disagree after restart.

### Contract the model-visible tool

Remove `model` from `AgentToolInput`, exact input decoding, spawn-tool plumbing,
the JSON Schema, descriptions, and parity fixtures. `agentInputSchema` no longer
takes provider model IDs and becomes independent of catalog size. The tool keeps
only task-owned fields: `description`, `prompt`, optional `subagent_type`,
`run_in_background`, `execution`, and `isolation`.

Remove model-catalog lookup that exists only to build this schema. Internal Host
entry points may still pass an already-resolved execution selection where isolated
Skills or other non-model callers require it; that private mechanism is not a
Role field and is never advertised to the delegating model.

### Clean cut and current specifications

The configuration decoder rejects Role-level `model` and `reasoningEffort` after
the cut and accepts only `agentExecution` for collaboration Agent types. Unknown,
reserved, empty, and malformed execution rows fail closed before a write or spawn.
No old Role value is copied automatically because pre-release configuration uses
a clean reset rather than a hidden migration.

Fold the shipped ownership, UI, layering, spawn validation, and lifecycle rules
into `agent-subagent-threads.md` and `agent-core.md`. Update
`agent-tool-design.md` so the exact `agent` contract has no model field or catalog
enum, and update `agent-integration.md` with the cross-layer verification
contract.

## Requirements

- **FR-1:** collaboration Agent definitions contain no model or reasoning fields;
  execution selection is a separate canonical-type-keyed configuration surface.
- **FR-2:** every collaboration Agent editor offers Follow parent plus currently
  usable provider models and supported reasoning levels without hard-coded model
  IDs.
- **FR-3:** definition, presentation, and execution edits commit atomically while
  preserving unknown stored model rows visibly rather than deleting them.
- **FR-4:** fresh spawn resolves explicit fields over the direct parent's effective
  selection and validates the complete result before durable admission.
- **FR-5:** unavailable or incompatible saved selections visibly fall back to the
  parent's complete selection without blocking; only failure of that fallback
  rejects the spawn, without child artifacts.
- **FR-6:** the persisted child effective configuration is the sole resume,
  restart, recovery, and nested-inheritance authority.
- **FR-7:** the model-visible `agent` tool and its prompt no longer contain a
  model parameter, model IDs, or catalog-dependent schema construction.
- **FR-8:** every fallback produces one durable launch/report warning with an
  Open Agent Settings action and structured guidance for the delegating model.
- **NFR-1:** adding any number of provider models leaves the serialized `agent`
  tool definition byte-identical.
- **NFR-2:** renderer code consumes provider/settings projections through the
  preload bridge and never reads credentials, configuration files, or main-only
  catalogs directly.

## Acceptance criteria

- **AC-1 (FR-1):** loader/decoder tests reject Role model/reasoning fields and
  accept layered `agentExecution` rows for built-ins and custom Roles; Role
  catalog hashes and model-visible descriptions are unchanged by execution edits.
- **AC-2 (FR-2):** renderer tests cover Follow parent, cross-provider choices,
  provider labels, supported effort filtering, an unavailable saved selection,
  its list/editor warning, and keyboard/focus behavior in light and dark themes.
- **AC-3 (FR-3):** writer tests prove one rejected combined edit changes neither
  Role/presentation nor execution data, and Role deletion removes only the
  matching same-layer execution row.
- **AC-4 (FR-4, FR-5):** Thread-service tests cover root and nested inheritance,
  explicit same-provider and cross-provider models, explicit reasoning-only
  selection, unsupported effort, disabled/missing credentials, and missing
  catalog models. Runtime drift uses the parent's complete selection; when that
  selection also cannot run, rejection occurs before ledger, worktree, Thread,
  budget, payload, or Turn creation.
- **AC-5 (FR-6):** restart and resume tests prove an existing Agent keeps its
  effective selection after Settings changes while the next fresh Agent uses the
  new row; nested children inherit the running parent's snapshot.
- **AC-6 (FR-7, NFR-1):** schema snapshots contain no `model`; varying the provider
  catalog from zero to many models produces identical tool bytes and performs no
  model-list lookup for collaboration tool construction.
- **AC-7 (NFR-2):** preload/IPC tests reject malformed execution drafts, renderer
  tests consume only secret-free provider views, and no Node/config-file access
  enters the renderer.
- **AC-8 (FR-8):** fallback starts a normally addressable child, records the
  requested and effective selection plus one bounded reason, renders one
  persistent non-blocking warning after reload and settlement, opens the matching
  Agent editor, and exposes structured guidance to the parent model without raw
  provider errors.
- **AC-9:** current behavior is folded into all owning specs; `bun run typecheck`,
  `bun run test:core`, `bun run test:renderer`, focused `bun run test:e2e`,
  `bun run docs:check`, and `git diff --check` pass.

## Files

Expected implementation surface on the merged #611/#613 baseline:

- `src/core/agent/configuration.ts`
- `src/core/agent/protocol.ts`
- `src/core/agent/codec.ts`
- `src/core/agent/tools.ts`
- `src/core/types.ts`
- `src/main/agent/AgentConfigurationLoader.ts`
- `src/main/agent/AgentConfigurationWriter.ts`
- `src/main/agent/thread/SubagentCollaboration.ts`
- `src/main/agent/thread/subagentExecutionProjection.ts`
- `src/main/agent/persistence/ThreadMetadataStore.ts`
- `src/main/desktopHost.ts`
- `src/renderer/ui/agent/AgentSettingsView.tsx`
- `src/renderer/ui/agent/AgentsSettings.tsx`
- `src/renderer/ui/agent/modelChoices.ts`
- `src/renderer/agent/components/SubagentReport.tsx`
- `src/renderer/agent/components/SubagentChip.tsx`
- `src/renderer/styles/settings-agent-editor.css`
- `src/core/i18n/messages/en.ts`
- `src/core/i18n/messages/zh-Hans.ts`
- focused configuration, writer, tool-schema, Thread-service, persistence,
  renderer, IPC, and E2E tests
- `docs/spec/agent-core.md`
- `docs/spec/agent-subagent-threads.md`
- `docs/spec/agent-tool-design.md`
- `docs/spec/agent-thread-rendering.md`
- `docs/spec/agent-integration.md`

The implementation queue is regenerated from `AgentRoleOverrides`,
`AgentToolInput.model`, `agentInputSchema`, `modelOverride`,
`reasoningEffortOverride`, Agent editor DTOs, and exact contract/spec search hits
after the predecessor rebase. This list is an ownership forecast, not a manual
completion ledger.

## Risks

- Provider and model form one runtime identity. Persisting only a model ID can
  select the wrong credential or endpoint when two providers expose the same ID.
- An inherited reasoning level may be unsupported by an explicit model, and an
  explicit reasoning-only setting may be unsupported by a future parent model.
  Validation must use the complete effective pair before admission, never the
  settings form's partial row.
- A missing model is not equivalent to Follow parent. Runtime may use the parent
  to preserve the task, but it must retain the standing selection, record the
  fallback, and tell both user and delegating model what actually happened.
- Built-ins have hidden backing Roles. Keying execution by backing name would
  create settings the UI cannot explain and make `explore` disagree with
  `explorer`.
- Separate writes can leave identity/definition and execution out of sync. The
  existing atomic validated writer must apply both halves in one edit.
- Removing child override columns changes persisted Agent data. A partial cut
  could let restart use a stale override while a live spawn uses the new map.
- A fallback warning shown only as a toast or model-authored prose will disappear
  or vary. It must be durable Host truth attached to the Agent execution and
  rendered once at the launch/report surface.
- `src/core/types.ts` is an infrastructure-ownership file. PM approval must
  explicitly release this coordinated interface change before implementation.

## Collision result

- PR #613 shipped the Tool Result Kernel and PR #611 subsequently shipped the
  model-visible context contract. This branch is rebased on both final Agent,
  tool, and specification surfaces.
- Open PR #617 owns the Outline CLI, built-in Outline Skill, import adapters,
  package build path, and their specifications. It does not overlap this plan's
  Agent configuration, collaboration, persistence, renderer, or specification
  files.
- No other open PR claim exists. The significant-review queue has room for this
  Draft PR, and the PM ratified implementation plus the coordinated
  `src/core/types.ts` interface change on 2026-09-02.
- Repeat `gh pr list` and derive the file queue again immediately before the
  first shared-surface edit; stop if a new claim overlaps.

## Open questions

None. Separation from Role definitions, user-owned Follow parent semantics,
provider-qualified explicit selection, visible non-blocking fallback for runtime
availability drift, and the exclusion of service tier/permission/task-local
controls are the proposed PM decisions.

## Implementation checklist

- [ ] Re-run collision checks and derive the exact search-hit queue from the
      merged #611/#613 baseline.
- [ ] Cut the configuration shape, editor DTO, writer transaction, and pre-release
      persisted child schema together.
- [ ] Add the Execution UI by reusing the existing provider/model catalog and
      localized settings primitives.
- [ ] Resolve and validate fresh child execution selection before durable
      admission; add visible parent fallback and preserve immutable resume and
      nested-inheritance behavior.
- [ ] Remove the model-visible override and every catalog-dependent schema path.
- [ ] Add focused Core/renderer/E2E coverage, fold the design into specifications,
      and archive this plan at the integration gate.
