# Agent Self-Modification

**Part of the [[agent-program]].** Scope after the program reorg: this plan owns
**self-observation, the `config` tool, hooks, config recovery, and curation policy**.
**Skill structure + authoring moved to [[agent-skills-authoring]]** (this plan no longer
owns §Skill Maintenance / §Curation). **Memory is owned by [[agent-conversation-model]]**.
Hooks here ride the program's typed **event bus + taxonomy** (F4); the task/teammate
hook events (`TaskCreated` / `TaskCompleted` / `TeammateIdle` / `Notification`) are
gated on the task/channel layer that [[agent-conversation-model]] builds (program
M2/M3). Single-agent self-configuration is this plan's; **multi-agent "configure each
other"** is [[agent-conversation-model]]'s.

**Status (2026-06-09).** Self-observation (`runtime_status`, read-only `doctor`) and the
`config` tool **landed in M1 (#153)**. **The remainder — prompt-only hooks, config
recovery/rollback, curation — is deferred** (PM call 2026-06-09: prioritize memory/render
over the rest of M2 self-mod). Escalate the capability boundary to the PM before building it.

## Goal

Define what "self-modification" means for Lin's agent and turn it into a
controlled product capability instead of allowing the model to edit runtime
files directly.

The target behavior is a policy-mediated self-maintenance loop:

```text
observe state
  -> diagnose problem or opportunity
  -> propose a bounded change
  -> request permission when needed
  -> apply through runtime-owned APIs
  -> verify effect
  -> persist audit data and allow rollback
```

This plan covers agent-facing requirements for configuration, hooks, skills,
diagnostics, recovery, and audit. It does not replace the existing runtime
permission plan; it builds on it.

## Non-goals

- Do not let the model directly edit Lin's provider settings, permission files,
  skill registries, app config, or runtime metadata as ordinary file writes. (This now
  also governs the **memory line** — written via a runtime-owned append surface, not
  `file_write`; the conversation-model memory-write decision was reversed to honor exactly
  this principle. The 2026-06-07 memory decision further narrows the target writer:
  there is no model-visible memory write tool; only Settings/Profile UI and
  Dream/extraction drive durable memory writes. See [[agent-conversation-model]]
  §Memory model.)
- Do not make self-modification a synonym for unrestricted autonomy.
- Do not add autonomous command hooks before read-only and prompt-only hooks are
  implemented and observable.
- Do not include memory design in this plan. Project memory, user memory,
  session memory, and automatic memory extraction are deferred.
- Do not allow the agent to relax hard blocks, configured deny rules, credential
  protections, or platform safety rules.
- Do not copy a full multi-agent gateway before Lin has a smaller single-agent
  maintenance loop.
- Do not add remote skill discovery, MCP/plugin skill lifecycle, or legacy
  command-directory compatibility as part of self-modification.

## Current State

Lin already has several foundations:

- Runtime-owned permission policy with `allow | ask | deny`, platform hard
  blocks, approval UI, and persisted permission events.
- Agent settings for provider/runtime behavior, skill toggles, compact toggle,
  additional skill directories, disabled skills, disabled agents, retry/cache
  behavior, and permission mode.
- Agent skills loaded from `~/.agents/skills` and workspace `.agents/skills`,
  including `allowed-tools`, slash invocation, path activation, model/effort
  overrides, embedded bash, and `context: fork`.
- Automatic and reactive compaction with persisted event-log replacements,
  skill-state restore, and recent file-context restore.
- Internal hook-like extension points: `transformContext`, `beforeToolCall`, and
  `afterToolCall`.

M1 shipped state (2026-06-07): Lin has `runtime_status`, read/write `config` for
a whitelisted runtime-settings surface, read-only `doctor`, audited
`config.change` events, and permission-gated config writes. **M2 added a fourth
self-maintenance tool — `dream` (#164)** — a trigger-only request for a
runtime-owned Memory Dream (the model cannot specify facts; the extractor decides
from recorded evidence). It lives alongside the others in
`agentSelfMaintenanceTools.ts`, is gated `agent.memory.dream` (in
`ALLOW_FORBIDDEN_ACTIONS`, always asks), and its design is owned by the Dream /
memory subsystem, not this plan. Remaining gaps are M2+:

- First-class lifecycle hooks such as `SessionStart`, `UserPromptSubmit`,
  `PreToolUse`, `PostToolUse`, `PreCompact`, or `PostCompact`.
- Review-card UI and last-known-good recovery for config mutations.
- Config base-version/hash checks and an explicit write queue.
- Skill-declared hook registration.
- Background skill curation.
- Background skill improvement or silent skill rewriting.
- A self-maintenance audit surface distinct from ordinary chat messages.

## Reference Review

This plan uses cc-2.1 as the primary reference. OpenClaw and Hermes are
supplemental references for safety, recovery, and operational polish. Lin should
copy the control points, not the full product surface.

### cc-2.1

Useful patterns:

- `ConfigTool` separates config read from config write: reads are auto-allowed,
  writes ask, and only whitelisted settings are supported. It keeps a small
  model-facing surface: `setting` plus optional `value`, where omitting `value`
  reads the current setting and providing `value` writes it.
- Settings writes go through settings APIs and editable sources, not arbitrary
  file edits.
- Skill invocation is a dedicated tool with its own permission check; skill
  `allowed-tools` narrows downstream tool calls but does not bypass hard blocks.
- Hooks have explicit event names, matcher metadata, input JSON, timeout, and
  structured output that can add context, block, or influence permission.
- `skillify` is user-invoked, interviews the user, shows a full `SKILL.md`, and
  asks for confirmation before saving.
- cc-2.1 does not expose separate `skill_create`, `skill_patch`,
  `skill_replace`, or `skill_write_support_file` tools. It creates and updates
  skills through `skillify`-style workflows plus ordinary `Write`/`Edit` tools
  after review and confirmation.
- Auto-compact uses a circuit breaker and has pre/post compact hook points.

Lin decisions:

- Keep the stable local `SKILL.md` path already documented in
  `docs/spec/agent-skills.md`.
- Do not copy legacy command directories, remote skill search, MCP/plugin skill
  lifecycle, foreground memory authoring, or background automatic skill rewriting.
- Start with read-only observation before enabling mutating config writes.
- Include controlled user-directed skill creation and editing in the first
  self-modification release, but follow cc-2.1's smaller tool surface: use
  `skillify`-style workflows plus existing file write/edit tools instead of a
  separate skill CRUD tool family.
- Treat skillify, skill editing, and hooks as product workflows with
  review/audit, not plain file edits.

### OpenClaw

Useful patterns:

- Config mutation uses a queue/lock, base hash checks, validation, runtime
  preflight, and retry on conflicts.
- Healthy config snapshots are promoted to last-known-good and corrupt/suspicious
  reads can recover from that backup.
- Doctor preflight can validate, repair, recover, and then continue with
  best-effort config when appropriate. Pre-release schema changes remain
  clean-cut; do not build versioned migration paths for agent config.
- Startup/session hooks are runtime owned and tied to workspace/session context.

Lin decisions:

- Runtime-owned config files need last-known-good snapshots before mutating
  self-configuration becomes normal.
- Recovery must keep the clobbered file, record audit events, and never restore
  redacted or polluted secret placeholders.
- Hooks should be first-class lifecycle events with clear trust precedence, not
  ad hoc shell files.

### Hermes

Useful supplemental patterns:

- `skill_manage` lets the agent create, patch, rewrite, delete, and add support
  files to local skills through a semantic tool instead of generic file writes.
- Background skill review runs in a fork with a tight tool whitelist and
  non-interactive dangerous-command denial.
- Curator supports dry runs, reports, snapshots, restore, pinning, and archive
  instead of hard delete.
- Skill guard scans externally sourced skills and records provenance/hash data.

Lin decisions:

- Adopt controlled agent-managed skill add/edit in the first version because
  users are likely to ask the agent to "save this as a skill" or "fix that
  skill" during normal chat.
- Do not adopt Hermes `skill_manage` as a model-facing tool in the first
  version. Borrow its validation, provenance, rollback, and curation ideas as
  policy around existing file tools.
- Do not adopt Hermes-style per-turn background skill review in the first
  version. User-directed or accepted review writes are in scope; silent
  background rewriting is not.
- Use Hermes only as a supplemental source for validation, provenance,
  rollback, and curation mechanics. cc-2.1 remains the primary reference for
  skill invocation and skillify UX.

## Definitions

### Self-Observation

The agent can inspect runtime state through bounded, structured tools. Examples:

- current provider and model;
- permission mode and effective permission policy summary;
- enabled and disabled skills;
- available agent definitions;
- compact status and recent compact failures;
- project workspace root;
- provider health;
- recent tool failures;
- past chat availability, when relevant to diagnostics.

Self-observation is read-only and should normally be allowed.

### Self-Configuration

The agent can request a change to runtime-owned settings through a narrow
cc-2.1-style config API. The model does not write the underlying settings file.

Examples:

- turn automatic skills on or off;
- turn slash skills on or off;
- turn compaction on or off;
- disable or re-enable a specific skill;
- change retry/cache/timeout values within bounded ranges;
- switch active provider or model only when the requested provider is already
  configured and the user confirms.

Self-configuration is mutating and should normally ask unless the setting is
explicitly declared safe to change automatically.

### Self-Skill Maintenance

The agent can help turn repeated workflows into local skills and can repair or
improve existing local skills through `skillify`-style workflows and the
existing `file_write`/`file_edit` tools. Skill changes alter future agent
behavior, so skill-path writes must be visible, reversible, and audited even
though they do not use a separate model-facing tool family.

Examples:

- create a skill for Lin permission review;
- create a skill for Electron packaging smoke checks;
- create a skill for outliner schema migration tasks;
- patch a skill after the user points out that it missed a verification step;
- add a `references/` note or script for a workflow the agent just learned.

First-version skill maintenance should support user-directed automatic writes:
when the user explicitly asks the agent to add, save, or edit a skill, the agent
may apply the change through existing file tools after permission resolution.
When the agent initiates the idea itself, it must show a concrete review preview
or diff before writing. Background skill review and curation can come later, and
only for agent-created skills by default.

### Self-Repair

The agent can diagnose broken runtime state and propose or perform recovery
through runtime-owned APIs.

Examples:

- provider key missing;
- selected model unavailable;
- configured skill path no longer exists;
- skill frontmatter is malformed;
- permission config failed validation;
- compact repeatedly failed;
- session restore left an interrupted subagent.

Repair may be read-only, prompt-only, or mutating. Mutating repair must use the
same permission and audit model as self-configuration.

## Capability Requirements

### 1. Runtime Status Tool

Add a read-only `runtime_status` tool.

It should return a compact structured object:

- app version;
- workspace root;
- current session id;
- provider id, model, effort, and provider health;
- permission mode;
- counts of enabled/disabled skills and agents;
- compact enabled flag and recent compact state;
- pending approvals count;
- recent tool failure summary;
- current runtime config version or hash, excluding secrets;
- last-known-good config health summary, when available;
- hook registry availability;
- provider auth kind and credential health summary, without credential values;
- available self-maintenance capabilities.

It must not return secrets, raw API keys, credential file contents, or sensitive
permission internals.

### 2. Config Tool

Add one cc-2.1-style `config` tool for whitelisted runtime settings instead of
separate `config_get`, `config_propose`, and `config_set` tools.

Input shape:

```json
{
  "setting": "string",
  "value": "optional string | boolean | number"
}
```

Behavior:

- if `value` is omitted, read the current setting and auto-allow;
- if `value` is present, write the setting and normally ask;
- reject unknown settings;
- validate type, enum options, and bounds before writing;
- use runtime-owned settings APIs and refresh in-memory state after writing;
- return `success`, `operation`, `setting`, and the current or new value.

Allowed read groups:

- `agent.runtime`;
- `agent.skills`;
- `agent.providers.summary`;
- `agent.permissions.summary`;
- `agent.compaction`;
- `agent.hooks`.

Secrets must be represented as capability flags such as `hasApiKey: true`, not
as values.

Write requests may render as review/approval cards in the UI, but that is not
a separate model-facing tool. The permission layer owns the review step.

Write requirements:

- whitelist every supported path;
- validate type and bounds;
- reject direct writes to permission hard blocks or credential-bearing values;
- default to `ask`;
- serialize writes through a runtime-owned queue or lock;
- validate before commit and refresh runtime caches after commit;
- use atomic writes;
- include old value, new value, reason, and initiator in the event log;
- expose rollback where practical.

Initial write whitelist:

- `agent.runtime.compactEnabled`;
- `agent.runtime.automaticSkillsEnabled`;
- `agent.runtime.slashSkillsEnabled`;
- `agent.runtime.disabledSkills`;
- `agent.runtime.disabledAgents`;
- `agent.runtime.providerTimeoutMs`, with bounds;
- `agent.runtime.providerRetryCount`, with bounds;
- `agent.runtime.providerCacheEnabled`;
- active model/provider only when the provider is already configured and the
  user approves.

Explicitly forbidden:

- API key values;
- permission `deny` removal;
- permission hard-block changes;
- workspace root relaxation;
- external command hooks;
- shell startup files;
- `.git/hooks`;
- app autostart or persistence locations;
- system policy files.

### 3. Doctor Workflow

Add a read-only doctor workflow. To stay close to cc-2.1's tool surface, this
can start as a slash command or UI diagnostic action instead of a model-facing
tool.

It should inspect:

- provider configuration health;
- missing or invalid model selection;
- skill path existence;
- skill frontmatter parse failures;
- skill tool availability;
- disabled-but-referenced skills;
- draft or agent-created skills that are malformed;
- malformed permission config;
- stale or conflicting runtime config version/hash;
- last-known-good snapshot availability and age;
- hook registry configuration and unsupported hook declarations;
- compact failure streak;
- event-log restore issues;
- subagent restore issues;
- interrupted tool calls or stale in-flight session state;
- excessive tool-output payload growth.

The first version should only return diagnostics and recommended actions.
Mutating repair actions should be separate review/approval requests.

### 4. Hook System

Add first-class lifecycle hooks in phases. **Hooks are an untrusted consumer of the
program's typed event bus + taxonomy** (F4, [[agent-program]]) — the same bus that
feeds [[agent-conversation-model]]'s trusted notifications. Design the event names once
in the program taxonomy; this section owns the **hook dispatch + trust gate**
(interceptors that can block/mutate, sandbox, precedence), not a private event vocab.

cc-2.1's hook event vocabulary includes:

```text
PreToolUse, PostToolUse, PostToolUseFailure, Notification, UserPromptSubmit,
SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop,
PreCompact, PostCompact, PermissionRequest, PermissionDenied, Setup,
TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult,
ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged,
FileChanged
```

Lin should use cc-2.1 event names where it implements the same lifecycle point.
It should not invent alternate names such as `PermissionRequest` variants unless
the lifecycle really differs.

Phase 1: read-only and prompt-only hooks:

- `SessionStart`;
- `UserPromptSubmit`;
- `PostToolUse`;
- `PostToolUseFailure`;
- `PreCompact`;
- `PostCompact`;
- `Stop` and `StopFailure`, if Lin needs turn-end diagnostics.

Supported handler types:

- `prompt`: append hidden model context or diagnostic notes.

Phase 2: controlled command hooks:

- `PreToolUse` and `PermissionRequest` may be added only in this phase because
  they can block or change tool behavior;
- `PermissionDenied` and `Notification` can also be added here if the permission
  and notification flows need hooks;
- command hooks must go through the existing tool permission layer;
- every command must have a timeout;
- output must be budgeted and persisted like other tool output;
- background command hooks must fail closed when user approval is unavailable.

Deferred handler types:

- `http`: defer until Lin has explicit URL allowlists and environment-variable
  interpolation policy for hook headers;
- `agent`: defer until subagent hooks are stable and the permission behavior is
  clear.

Phase 3: subagent/config/source hooks:

- `SubagentStart`;
- `SubagentStop`;
- `ConfigChange`;
- `InstructionsLoaded`;
- `CwdChanged`;
- `FileChanged`.

Defer cc-2.1 events that belong to surfaces Lin does not have yet:

- `TeammateIdle`, `TaskCreated`, and `TaskCompleted` until Lin has team/task
  orchestration;
- `Elicitation` and `ElicitationResult` until MCP elicitation is supported;
- `WorktreeCreate` and `WorktreeRemove` until worktree isolation exists.

Hook sources should mirror cc-2.1's source split where useful:

- user-level hooks;
- project-level hooks;
- local project hooks;
- conversation/run-scoped transient hooks;
- skill-declared hooks;
- plugin hooks, if Lin later supports plugins;
- admin/system hooks, if Lin later has a managed policy layer.

Skill-declared hooks should register as run-scoped or conversation-scoped
transient hooks only after the skill has been invoked or explicitly enabled. They
must not silently persist beyond that scope unless the user accepts a
project/user hook write.

Hook precedence should mirror config trust:

```text
system/admin > user > project > skill > model-suggested run hook
```

Lower-trust hooks must not override higher-trust denials.

### 7–8. Skill Maintenance & Curation → moved to agent-skills-authoring

**Moved.** Skill creation / editing (`skillify` + `file_write`/`file_edit`, no
model-facing CRUD tool family, provenance / snapshot / rollback, `.agents/skills/**`
write classification, draft-default for agent-initiated writes, no allowed-tools
self-escalation) and background **curation** (agent-created only, archive-over-delete,
dry-run, opt-in) are now owned by [[agent-skills-authoring]]. They reuse this plan's
permission + audit + event machinery; the skill rows of the Policy Matrix moved with
them. This plan keeps **config / hooks / recovery / observation**; the `config` tool is
still the mechanism for the *capability* side of self-configuration.

### 9. Config Recovery

Add last-known-good snapshots for runtime-owned config files.

Requirements:

- snapshot after successful validation and write;
- keep bounded history;
- detect suspicious reads, parse failures, and missing required sections;
- restore only runtime-owned files;
- preserve the rejected/clobbered file before restoring;
- verify backup hash and schema before restore;
- skip restore if the backup contains redacted or placeholder secrets;
- record recovery events;
- ask before replacing user-visible configuration unless the app cannot start
  without recovery.

## Policy Matrix

| Area | Read | Review preview | Auto write | Ask write | Deny |
| --- | --- | --- | --- | --- | --- |
| Runtime status | allow | n/a | n/a | n/a | secrets |
| Provider summary | allow | allow | deny | ask for active provider/model switch | API key value writes |
| Skill toggles | allow | allow | deny initially | ask | hidden install from network |
| Compaction toggle | allow | allow | deny initially | ask | bypassing context safety |
| Hooks | allow listing | allow | deny initially | ask | unapproved shell hooks |
| Permissions | summary only | narrow ask-rule preview | deny | ask for user-authored allow/ask changes | hard-block or deny removal |
| Credentials | capability flags only | setup guidance | deny | user UI only | model-provided raw secret persistence |

## UX Requirements

Self-modification should be visible but not noisy.

User-facing surfaces:

- self-maintenance review/approval card;
- runtime doctor panel;
- skill change review;
- skill curation report;
- hook activity/audit list;
- rollback action for reversible changes.

Review/approval cards should show:

- what will change;
- why the agent wants it;
- risk level;
- exact old and new values;
- permission source;
- verification plan;
- rollback option.

The agent should receive a structured tool result after approval or rejection,
so it can continue without guessing.

## Event Log Requirements

Persist events for:

- status/doctor checks when they produce diagnostics;
- config write requests and approval decisions;
- approved config writes;
- denied config writes;
- skill write previews and approval decisions;
- skill creates, patches, replacements, support-file writes, rollbacks, and
  archived skills;
- skill curation reports;
- skill hook registrations;
- hook executions;
- hook failures;
- config recovery and rollback.

Events should include:

- initiator: `user`, `agent`, `hook`, `runtime`, or `system`;
- scope: `session`, `workspace`, `user`, or `system`;
- old/new values where safe;
- redacted secret placeholders;
- linked permission request id when applicable;
- verification result when available.

## Rollout

**Execution (complete-per-PR).** Shape (b): each stage below is an **independent
complete capability shipped as its own PR** — the ordering is a safety/permission
ramp and dependency order, not one feature sliced across stages. Ship each
capability end-to-end within its PR (e.g. Stage 3 = the `config` write tool *plus*
its approval cards, version checks, and runtime write path — never the tool
without its approval UI). Recovery (snapshots + rollback) and curation are
**separate** complete features, not one Stage-5 bundle; a dry-run curator is a
complete PR only if dry-run is the shipped behavior, with the live curator a later
complete PR. **Landed (M1, #153):** Stage 1 self-observation + the Stage 3
`config` tool. **Deferred (PM, 2026-06-09):** Stages 4–6 (prompt hooks, recovery,
curation, command hooks).

### Stage 1: Read-Only Self-Observation

- Add `runtime_status`.
- Add read-only `config` reads by omitting `value`.
- Add read-only doctor workflow.
- Add basic event-log entries for diagnostics.

### Stage 2: Controlled Skill Maintenance → moved to agent-skills-authoring

The `/skillify` + file-tool authoring, `.agents/skills/**` write classification,
diff/preview, provenance / snapshots / rollback, and event-log entries are now planned
in [[agent-skills-authoring]] (program M1). It reuses Stage 1's read/observe surface and
Stage 3's permission/audit machinery.

### Stage 3: Controlled Config Writes

- Enable `config` writes by passing `value`.
- Render config write approval cards.
- Let users accept/reject writes through the permission layer.
- Add config base version/hash checks and a runtime write queue before accepted
  writes mutate settings.
- Apply accepted changes through runtime-owned write paths.

### Stage 4: Prompt-Only Hooks

- Add hook event vocabulary.
- Implement `SessionStart`, `UserPromptSubmit`, `PostToolUse`,
  `PostToolUseFailure`, `PreCompact`, `PostCompact`, and optionally
  `Stop`/`StopFailure` prompt handlers.
- Keep team/task, MCP elicitation, and worktree hook events deferred.
- Keep hooks app-owned at first.

### Stage 5: Recovery and Curation

- Add last-known-good config snapshots.
- Add rollback.
- Add optional skill curator in dry-run mode first.

### Stage 6: Controlled Command Hooks

- Add project/user hook registration.
- Route command hooks through tool permissions.
- Add timeout, audit, and output budgeting.

## Open Questions

- Should accepted config writes be applied from the chat approval card or from
  a dedicated settings review drawer?
- Which settings are safe enough for auto-write after repeated user approvals?
- Should project hooks be stored in `.agents/hooks.json`, inside skills
  frontmatter, or only in Lin-managed app data initially?
- What is the minimum rollback UI needed before mutating config is safe?
- Should explicit user-requested skill writes show a compact approval card or a
  full diff by default?
- Should Lin add cc-2.1-style per-skill permission suggestions for invoking a
  specific skill, or is the current global permission center enough?

## Implementation Checklist

- [x] Define protocol types for self-maintenance tools.
- [x] Add `runtime_status`.
- [x] Add read-only `config` reads.
- [x] Add read-only doctor workflow.
- [x] Add accepted config write adapter for whitelisted settings.
- [x] Persist applied config changes as `config.change` events.
- [x] Route config writes through the permission layer.

<!-- The remaining items below are PM-DEFERRED (2026-06-09) + security-sensitive — NOT a ready
     lane; escalate the capability boundary before any build, and add /security-review at the gate.
     Re-cut into COMPLETE features per AGENTS.md + the Rollout (§ "Stage 3 = … never the tool
     without its approval UI"): each line is ONE shippable PR, not a scaffold-then-fill slice. -->
- [ ] **Config-write review/approval feature (one complete PR):** approval-card payloads +
      dedicated review/approval event types + card UI + base-version/hash checks + write queue,
      shipped together (the `config` write tool is never delivered without its approval UI).
- [ ] **Config recovery feature (one complete PR):** last-known-good snapshots + rollback events
      + rollback UI, shipped together (a snapshot store without a rollback path delivers nothing).
- [ ] Prompt-only hook registry (Stage 4, on the program F4 event bus — [[agent-program]]) — its own complete PR.
- [ ] (Skill authoring + curation checklist → [[agent-skills-authoring]].)
