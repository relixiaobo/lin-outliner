---
status: draft
owner: codex
updated: 2026-06-11
---

# Agent Permission Safety Modes

## Goal

Replace the current expert-oriented permission surface with a small set of
user-facing safety modes. The user chooses a level once, then Lin derives the
tool policy, approval frequency, and workspace-skill trust behavior from that
level. The lowest-friction level must be able to default-allow normal execution
and permissions for a workspace, while the runtime keeps non-negotiable hard
blocks for host destruction, credential exfiltration, persistence writes, and
permission/payment self-modification.

This is a plan proposal for main review, not an implementation PR.

## Non-goals

- Do not relax Electron renderer hardening, CSP, window navigation policy,
  OS-permission allow-lists, or `userData` isolation.
- Do not remove per-action rules or approval event logging; presets sit above the
  existing engine.
- Do not implement enterprise policy/admin controls.
- Do not add migrations. Pre-release settings may be normalized in place.

## Current State

The shipped product has two permission modes:

- `trusted`: the runtime default in `DEFAULT_AGENT_RUNTIME_SETTINGS`.
- `restricted`: a tool-preapproval mode used by custom agents and skill
  `allowed-tools`.

The runtime setting is a two-value protocol type:
`AgentPermissionMode = 'trusted' | 'restricted'`. Settings normalization accepts
only those values, so introducing new modes touches the protocol surface, settings
normalization, agent authoring, i18n, and tests.

Every tool call goes through `agentRuntime.ts` `beforeToolCall`, which loads
global permission rules, combines skill/subagent preapproval rules, then calls
`evaluateAgentToolPermission`. The evaluator is already the correct policy seam:
it returns only `allow`, `ask`, or `deny`.

The decision engine is descriptor based. Each tool action maps to an
`AgentToolActionKind` and a `ToolActionDescriptor` with a default decision,
external-effect flag, high-consequence flag, access scope, and optional hard
block. Current defaults are mixed:

- Allowed by default: workspace file reads/writes, outliner edits, web search,
  memory recall, status/config reads, safe read/search shell commands.
- Ask by default: web fetch, node delete, local code execution/project scripts,
  dependency install, network writes, git push/GitHub mutation, deploy/publish,
  file delete, subagent spawn, skill writes, Dream, config writes, sensitive path
  reads, background processes, sandbox override.
- Denied/hard-blocked: unknown shell, outside-workspace access unless the run
  opted into outside access, credential/persistence/git-internal writes,
  sensitive-data exfiltration, destructive host commands, permission modification,
  and payment purchase.

Global permissions are stored as `agent-tool-permissions.json` under `userData`
with `{ permissions: { allow, ask, deny } }`. Parsing is intentionally
fail-closed. The settings UI exposes common action-kind rows as `Ask first` or
`Always allow`; invalid/unsupported JSON rules surface diagnostics.

The approval card supports `Approve once`, `Always allow` when a validated
`Action(...)` rule exists, and `Deny once`. "Always allow" appends one global
allow rule. Many high-leverage actions cannot currently be globally allowed:
`agent.config.write`, `agent.memory.dream`, `agent.skill.write`,
`agent.subagent.spawn`, `shell.unknown`, and broad/arbitrary `Bash(...)` rules.
That means a true "Full Access" mode cannot be implemented as prefilled global
allow rules without weakening the parser. It needs a first-class mode layer.

The ask resolver is conservative. Explicit configured `ask` always asks;
safe-read allow-list descriptors auto-allow; every shipped descriptor has
`classifierAutoAllowEligible: false`, so the classifier path is effectively dead
in production. If no approval channel exists, an ask becomes a structured
permission denial. Skill embedded shell uses the same evaluator and ask resolver.

Project skills now require exact-byte acceptance before automatic model use.
Accepted skills still do not bypass runtime permissions; their `allowed-tools`
only add run-scoped preapproval metadata. Slash invocation remains user consent
for that run. This is safer than the old fail-open behavior, but it creates a
granular acceptance burden for consumer users when a trusted workspace ships many
skills.

The Electron/native host security shell is separate from agent permissions:
renderer windows keep `contextIsolation: true`, `sandbox: true`,
`nodeIntegration: false`; navigation is blocked or opened externally; packaged
`file://` gets CSP; Electron permissions are denied except sanitized clipboard
write; single-instance and before-quit flush stay fixed. These controls should
not vary by agent safety mode.

## Product Problem

The current surface is correct for engineers but too fragmented for ordinary
consumer users:

- Users see repeated per-action prompts and may train themselves to click
  through without reading.
- The Settings permission center requires understanding action kinds such as
  `shell.project_script` or `git.publish_remote`.
- Skill acceptance is exact-byte and safe, but per-skill acceptance does not map
  to the user's real intent: "I trust this workspace/project."
- "Trusted" sounds like the low-friction mode, but it still asks for many common
  development actions. "Restricted" is a developer-facing term rather than a
  consumer-facing safety level.

The right abstraction is a preset ladder, with advanced per-action overrides
available but not primary.

## Proposed Modes

Expose four safety modes in user-facing copy. Keep internal identifiers explicit
and stable.

| UI name | Internal id | Product meaning | Default behavior |
| --- | --- | --- | --- |
| Read Only | `read_only` | Let the agent analyze but not change anything. | Allow passive reads/searches/status. Deny local mutations, shell execution beyond read/search, external writes, subagents, skill writes, config writes, Dream writes, and automatic project-skill trust. |
| Ask First | `ask_first` | Maximum visibility with fewer hard denials than current `restricted`. | Allow passive reads/searches. Ask before workspace edits, deletes, local execution, web fetch, external effects, subagents, skill writes, config writes, Dream, and project-skill automatic use. |
| Balanced | `balanced` | Recommended default for most users. | Equivalent to today's `trusted` plus cleaner grouped UX: allow normal local reads/writes and outliner edits; ask for code execution, deletes, dependency installs, web fetch, external mutations, sensitive/outside paths, subagents, skill writes, config writes, Dream, and new/changed project skills. |
| Full Access | `full_access` | Lowest-friction workspace automation. | Allow classified non-redline tool actions for this workspace by default, including local execution, workspace edits/deletes, web fetch, dependency install, git/GitHub mutation, deploy/publish, network writes, subagent spawn, Dream, and skill invocation. Still block hard redlines and keep audit events. |

Recommended product default: `balanced`.

Allow users to choose `full_access` during onboarding or from Settings. Also allow
an advanced preference: "Use this as my default for new workspaces." That answers
"can I set default trust?" without silently making every install full access.

## Safety Floors

Mode presets may reduce prompts, but they must not disable the following floors:

1. Platform hard blocks always run before preset decisions.
2. User-configured deny rules always win.
3. Sensitive-data exfiltration is always denied.
4. Host destruction, disk formatting, power commands, remote-code pipe-to-shell,
   known shell obfuscation, git-internal writes, credential/persistence writes,
   permission modification, and payment purchase are always denied.
5. Unknown shell remains denied in all modes. Full Access does not mean "run text
   the classifier cannot understand."
6. Electron renderer/native-host hardening is not mode-dependent.
7. Every allowed/blocked/asked decision is still written to the permission event
   log.

The only debatable floor is `agent.subagent.spawn`. Today it cannot be globally
allowed. For Full Access, I recommend allowing it by profile, not by global rule,
because the user explicitly selected a mode that means autonomous execution.
Balanced and stricter modes should continue to ask.

## Workspace Trust

Add a workspace-level trust layer instead of forcing users to accept every skill
one by one.

Proposed behavior:

- `read_only`: project skills are slash-visible, but automatic project-skill
  listing remains disabled unless the exact skill bytes were individually
  accepted.
- `ask_first`: same as current exact-byte behavior.
- `balanced`: show a single "Trust current workspace skills" action when pending
  project skills exist. It records acceptance for all currently displayed
  `project` skill hashes. New or changed project skills return to pending.
- `full_access`: when the user enables Full Access for the workspace, the runtime
  records a workspace trust fact and treats current project skills as accepted
  for automatic model use. New or changed project skills can either auto-ratify
  under the workspace trust fact or appear in a quiet "recently trusted" audit
  list. Main should decide this product point; my recommendation is:
  auto-ratify project skills under Full Access, but keep a Settings audit row and
  a one-click "revoke workspace skill trust" action.

Trust should be scoped to a workspace identity, not global skill names. Use a
normalized root path plus optional git remote identity when available. Do not
reuse trust across unrelated clones unless the user sets Full Access as a global
default for new workspaces.

Skill acceptance remains a trust fact, not a permission bypass. Full Access makes
skill discovery and downstream tool calls low-friction, but the hard redlines
still stand.

## Engine Design

Do not encode modes by materializing many global allow/ask rules. The existing
rule parser intentionally rejects broad and high-leverage allow rules; preserving
that property is valuable. Add a preset layer to the policy evaluator.

Suggested pipeline:

1. Derive descriptors exactly as today.
2. Apply platform hard blocks exactly as today.
3. Apply configured deny rules.
4. Apply safety-mode profile decision.
5. Apply configured ask/allow overrides as refinements within the mode's allowed
   override envelope.
6. Route `ask` through the existing ask resolver.
7. Emit the same permission events.

The profile layer can be implemented as a table over descriptor fields:

```ts
type AgentSafetyMode = 'read_only' | 'ask_first' | 'balanced' | 'full_access';

interface SafetyModeProfile {
  decide(descriptor: ToolActionDescriptor): GlobalToolPermissionDecision | null;
  allowOutsideWorkspaceRead: boolean;
  allowOutsideWorkspaceWrite: boolean;
  projectSkillTrust: 'exact_hash' | 'batch_exact_hash' | 'workspace_auto';
}
```

`null` means "use descriptor default." This lets `balanced` stay close to today's
behavior while `read_only`, `ask_first`, and `full_access` are explicit.

Recommended profile decisions:

| Action category | Read Only | Ask First | Balanced | Full Access |
| --- | --- | --- | --- | --- |
| Local/outliner reads, search, status | allow | allow | allow | allow |
| Workspace file/outliner edits | deny | ask | allow | allow |
| Local deletes | deny | ask | ask | allow |
| Read outside workspace | deny | ask if workspace policy permits | ask if workspace policy permits | allow if workspace is in Full Access |
| Sensitive path read | deny | ask | ask | ask or allow only after separate "Computer files" opt-in |
| Sensitive/persistence write | deny | deny | deny | deny |
| Web search | allow | allow | allow | allow |
| Web fetch | deny or ask | ask | ask | allow |
| Local project scripts/code execution | deny | ask | ask | allow |
| Dependency install | deny | ask | ask | allow |
| Network write | deny | ask | ask | allow |
| Git/GitHub mutation | deny | ask | ask | allow |
| Deploy/publish | deny | ask | ask | allow |
| Background process | deny | ask | ask | allow, but surface running task visibly |
| Sandbox override | deny | ask | ask | ask even in Full Access |
| Skill write | deny | ask | ask | allow in Full Access, but created/changed skill enters trust audit |
| Skill invoke | allow only for accepted/user-invoked | allow | allow accepted | allow with workspace trust |
| Subagent spawn | deny | ask | ask | allow |
| Config write / permission modify | deny | ask for config write, deny permission modify | ask for config write, deny permission modify | ask for config write, deny permission modify |
| Dream write | deny | ask | ask | allow |
| Unknown shell | deny | deny | deny | deny |

The "Sensitive path read" row is intentionally not fully decided. For a consumer
product, Full Access to the workspace should not automatically mean the agent can
read SSH keys, Keychains, `.env`, or package tokens. If product wants true whole
computer automation, make that a separate second switch under Full Access:
"Include sensitive local files." It should remain off by default.

## Settings Model

Replace or alias `permissionMode` with a new protocol field:

```ts
type AgentSafetyMode = 'read_only' | 'ask_first' | 'balanced' | 'full_access';

interface AgentRuntimeSettings {
  safetyMode: AgentSafetyMode;
  permissionMode?: never; // or transitional alias during one PR
}
```

Because the product is pre-release, prefer replacing the field cleanly and
normalizing old values:

- old `trusted` -> `balanced`
- old `restricted` -> `ask_first` for runtime settings
- old agent-definition `permission-mode: restricted` -> `ask_first`
- old agent-definition `permission-mode: trusted` -> `balanced`

If the team wants a smaller protocol diff, keep `permissionMode` as the storage
field for one PR and extend its union. I do not recommend that long-term because
"permission mode" is the wrong user-facing frame.

Global action rules stay as advanced overrides:

- Settings primary pane shows the preset selector and clear consequences.
- "Advanced permissions" disclosure shows the existing action rows.
- Existing `Always allow` approval writes still append action rules.
- Invalid JSON diagnostics stay visible.

Add per-workspace override storage:

```ts
interface WorkspaceTrustSettings {
  workspaceId: string;
  safetyMode?: AgentSafetyMode;
  projectSkillTrust?: 'exact_hash' | 'workspace_auto';
  updatedAt: number;
}
```

This can live under `userData` next to permission settings. Keep it local and
machine-specific.

## UI Design

Onboarding and Settings should present modes as a single segmented/list choice,
not as ten permission rows.

Recommended copy:

- Read Only: "Analyze only. No edits or commands."
- Ask First: "Ask before changing files, running code, or contacting sites."
- Balanced: "Work normally in this workspace. Ask for risky or external actions."
- Full Access: "Run, edit, install, publish, and use workspace skills without
  routine prompts. Hard safety blocks still apply."

When the user chooses Full Access, show a compact confirmation sheet:

- Scope: current workspace.
- What becomes automatic: commands, edits, installs, network/Git/deploy actions,
  subagents, workspace skills.
- What remains blocked: credential exfiltration, destructive host commands,
  persistence/credential writes, unknown shell, permission/payment modification.
- Optional checkbox: "Use Full Access as my default for new workspaces."

For pending project skills in Balanced, replace many Accept buttons with a
workspace row:

- "3 workspace skills are pending."
- Primary action: "Trust current workspace skills."
- Secondary action: view individual skills.

For Full Access, show a persistent status chip in Settings:
"Full Access for this workspace." Include "Revoke" and "Review activity."

## Implementation Plan

This is one complete feature PR after PM/main ratification.

1. Rename/extend protocol:
   - Add `AgentSafetyMode` in core types.
   - Normalize old `trusted`/`restricted`.
   - Update runtime settings, agent definitions, authoring markdown parsing, and
     i18n.
2. Add mode profile evaluation:
   - Keep descriptor derivation and hard blocks unchanged.
   - Insert `resolveSafetyModeDecision` after hard blocks and configured deny.
   - Keep events and ask resolver unchanged.
3. Add workspace trust settings:
   - Store per-workspace safety/trust state under `userData`.
   - Add batch accept for current project skill hashes.
   - Add Full Access workspace-auto trust behavior.
4. Redesign Settings:
   - Replace top-level permission rows with preset selector.
   - Move existing rows under Advanced.
   - Add Full Access confirmation sheet and workspace-skill batch trust row.
5. Update specs and tests:
   - `docs/spec/agent-tool-permissions.md`
   - `docs/spec/agent-skills.md`
   - core tests for every profile/action category
   - renderer tests for preset save/advanced overrides
   - e2e Settings visual checks for light/dark Full Access and pending skills

## Acceptance Criteria

- A user can select `Read Only`, `Ask First`, `Balanced`, or `Full Access` in
  Settings.
- `Balanced` preserves today's effective default behavior except for grouped UX.
- `Full Access` allows classified non-redline workspace actions without approval
  prompts.
- Hard redlines still deny before any mode or global allow rule.
- A user can set Full Access as the default for new workspaces.
- Project skills can be trusted in batch for the current workspace.
- Full Access can auto-ratify workspace project skills according to the ratified
  product decision.
- Approval events still record mode-derived allows/blocks.
- Existing `trusted`/`restricted` settings normalize deterministically.

## Risks

- Full Access can surprise users if it includes external mutations such as git
  push or deploy. Mitigation: make the confirmation sheet concrete, keep the
  scope visible, and provide quick revoke.
- "Whole computer" trust is materially different from "workspace" trust.
  Mitigation: Full Access is workspace-scoped first; sensitive local paths need a
  separate explicit opt-in if product wants that capability.
- Per-agent modes may conflict with global mode. Mitigation: subagent/agent
  profile mode should narrow or inherit by default; widening above the workspace
  mode should require explicit user creation/editing.
- Existing tests use `trusted`/`restricted`. Mitigation: normalize old values and
  update fixtures in one PR.
- PR #184 run unification touches adjacent runtime permission flow. No direct
  file overlap is required for this plan document, but implementation should
  rebase after #184 if it lands first.

## Open Questions for Main / PM

1. Should Full Access auto-ratify newly changed project skills, or only batch
   accept the current hashes when the mode is enabled?
2. Should Full Access include git push/deploy by default, or should external
   publish remain a separate opt-in inside Full Access?
3. Should sensitive local reads ever be covered by Full Access, or always require
   a separate "Computer files" permission?
4. Should custom agent definitions be allowed to widen above the workspace's
   selected safety mode, or only narrow it?
5. Should the product default be `balanced` for all users, or should onboarding
   force an explicit choice before the first agent run?

## Collision Check

Open PRs checked on 2026-06-11:

- #186 `codex-2/focus-selection-polish`: no overlap; UI focus/selection.
- #184 `cc-2/agent-run-unification`: adjacent runtime permission flow, no direct
  overlap with this docs-only proposal. Implementation should sequence behind or
  rebase over #184 if both change `agentRuntime.ts` / permission event flow.
