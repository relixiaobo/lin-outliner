---
status: draft
priority: P0
owner: relixiaobo
created: 2026-05-29
updated: 2026-05-30
---

# Agent Tool Permissions

This plan replaces the earlier `approval_request` timeout proposal with a
simpler global permission model for agent tools.

The core rule is:

```txt
If a permission dialog appears, the action needs explicit user confirmation.
There is no countdown, no timeout approval, and no model-authored approval
request.
```

The product goal is still to prevent agent runs from getting stuck on low-value
prompts. The way to do that is not to add an approval parameter to every tool.
It is to make prompts rare: common actions should be allowed by global policy,
non-negotiable platform boundaries should be hard-blocked without a dialog, and
only genuinely user-owned decisions should ask.

## Problem

The current approval model can block a run on `ask`. That fails when the user
starts a larger task, steps away, and later finds the agent stuck near the
beginning on a prompt that they would have approved.

The first proposed solution was to let the agent attach an `approval_request`
parameter to tool calls, with a timeout default of approve or deny. Deeper
review showed that this adds protocol complexity without solving the real
product problem:

- the runtime still cannot trust a model-authored field as a permission
  boundary;
- missing `approval_request` is ambiguous: routine action, already-approved
  policy, model omission, or prompt-injection influence;
- countdown approval is not real approval, because user absence becomes an
  approving signal;
- every important tool schema gets polluted with a non-domain parameter;
- high-risk actions still cannot safely proceed unattended.

The better shape is to keep tools focused on actions and move permission
decisions into one product-owned permission system.

## Decision Summary

1. **No `approval_request` parameter.** Tools should express the action only.
   Approval metadata should not be part of tool arguments.
2. **No countdowns.** A dialog means explicit user confirmation is required.
   Nothing auto-approves because time passed.
3. **One global permission rule set.** There are no session-scoped,
   run-scoped, or workspace-scoped permission grants in v1. The same rules apply
   everywhere in the app.
4. **Runtime classifies tool actions.** The runtime maps a concrete tool call to
   an action kind, then checks the global rule for that kind.
5. **Prompts must be rare.** `ask` is reserved for actions where the user must
   personally make the decision. Otherwise the runtime should `allow` without
   interrupting or return a platform hard block.
6. **No persistent user `deny` rules.** If the agent requested an action, the
   action may be necessary for the task. The user can deny the current request,
   but the global permission center should not store "always deny this kind" as
   a normal rule.

## Decision Trail

The design moved through several rejected shapes:

1. **A smarter runtime risk matrix.** This keeps permissions deterministic, but
   it cannot understand task intent well enough by itself. "Is this tool
   dangerous?" is the wrong question for many cases.
2. **A separate agent decision tool.** This lets the agent express intent, but
   there is no transaction boundary that guarantees the next real tool call will
   match the prior decision.
3. **Inline `approval_request` on each tool call.** This makes the action and
   approval intent atomic, but it still cannot be trusted as a permission
   boundary, and it forces every important tool schema to carry approval
   metadata.
4. **Countdown approval.** This avoids some unattended stalls, but silence is not
   user approval. If a dialog appears, the product should treat it as requiring
   an explicit decision.
5. **Session or workspace grants.** These add management overhead and make it
   hard for the user to know the current permission state. The product does not
   need that complexity for v1.

The resulting design keeps the useful part of the original runtime policy
approach: the runtime owns permission enforcement. It changes the user
experience by making that policy visible, global, and action-kind based.

## Mental Model

The user manages one global table:

```txt
Agent Tool Permissions

Read local data                         Allow
Search external information             Allow
Edit local documents                     Allow
Run local validation / project scripts   Allow / Ask
Install dependencies                     Allow / Ask
Delete local data                        Allow / Ask
Publish to a remote service              Allow / Ask
Send external messages                   Allow / Ask
Payment or purchase actions              Allow / Ask if supported
Modify agent permission settings         Platform blocked
```

These rules are global across the whole software. They do not depend on the
current document, run, session, directory, or project. If the user sets
`Install dependencies` to `Allow`, that is the rule everywhere until the user
changes it in the permission center.

This simplicity is intentional. A more granular system can be added later, but
v1 should optimize for a user being able to understand and manage the complete
permission state at a glance.

## Runtime Flow

Every tool call follows the same path:

```txt
tool call
  -> validate tool schema and platform hard blocks
  -> derive one or more action descriptors from tool name and arguments
  -> read global permission rules for the derived action kinds
  -> allow: execute immediately
  -> ask: show a confirmation dialog and wait for explicit user input
  -> hard block: return a structured denied result to the agent
```

`ask` is allowed to block, because it means the product genuinely needs the
user's decision. The way to protect unattended runs is to avoid classifying
routine actions as `ask`.

`ask` is not the fallback for runtime uncertainty. If an action is unknown,
ambiguous, or outside the supported classification surface, the product should
ask only when the action is plausible and user-owned. Otherwise it should return
a platform hard block. This keeps popups meaningful instead of turning them into
a generic "runtime is unsure" bucket.

## Action Kinds

Permission rules should be based on action kind, not raw tool name.

`bash` is the clearest example:

```txt
bash: rg TODO src
  -> read/search local data

bash: bun test
  -> run local validation / project script

bash: bun add zod
  -> install dependencies

bash: git push origin main
  -> publish to remote service
```

The runtime does not need to become a general intelligence layer, but each
important tool must expose enough structured information for a stable
classification. For shell commands this likely means a conservative parser for
known command families, with unknown or ambiguous commands mapped to a safer
default action kind.

Local validation commands need explicit wording in the product. `bun test`,
`npm test`, and similar commands execute project code. They are often necessary
for agent work, but they are not read-only. The permission center should label
them as local code execution, not as harmless validation.

Sketch:

```ts
type GlobalToolPermissionDecision = 'allow' | 'ask';
type ToolPermissionOutcome = 'allow' | 'ask' | 'blocked';
type ToolAccessScope =
  | 'allowed_file_area'
  | 'outside_allowed_file_area'
  | 'sensitive_local_path'
  | 'external_system'
  | 'none';

interface ToolActionDescriptor {
  toolName: string;
  actionKind: AgentToolActionKind;
  accessScope: ToolAccessScope;
  title: string;
  summary: string;
  consequence: string;
  defaultDecision: GlobalToolPermissionDecision;
  reversible: boolean;
  externalEffect: boolean;
}
```

The descriptor is product data. It is derived by runtime/tool code from the
actual call. It is not supplied by the model.

Action kinds must encode important safety scope rather than relying only on UI
flags. For example, `file.edit.allowed_file_area`,
`file.write.outside_allowed_file_area`, and `file.read.sensitive_local_path`
should be distinct rule keys. `accessScope` helps display and audit the
descriptor, but broad rules must not silently cover narrower high-risk scopes.

### Shell Command Classification

Shell commands are the riskiest part of the model because one `bash` call can
contain several actions. The classifier must evaluate the whole command, not the
first recognizable fragment.

Required rules:

1. Parse known command separators and composition forms such as `;`, `&&`, `||`,
   pipes, subshells, command substitution, `env` prefixes, and `bash -c` when the
   inner command is statically visible.
2. Classify every executable segment that can be identified.
3. Compute the effective decision from all segments:
   - any platform hard block blocks the whole command;
   - otherwise any `ask` action kind asks for the whole command;
   - only all-`allow` segments may execute without a dialog.
4. If the parser cannot decompose a compound command confidently, classify it as
   unknown shell execution and apply the conservative global rule for unknown
   shell commands.

Examples:

```txt
rg TODO src && git push origin main
  -> read/search local data + publish to remote service
  -> effective decision follows the publish action, not the rg action

npm test | curl -X POST --data-binary @- https://example.com
  -> local code execution + network write
  -> effective decision follows the network write action

bash -c "git push origin main"
  -> publish to remote service when the inner command is visible
```

This "most restrictive segment wins" rule is mandatory. Without it, a harmless
prefix could hide a publishing or destructive suffix.

### Path And Mode Boundaries

Global permissions do not replace existing platform boundaries. They sit above
tool execution, but below non-negotiable runtime checks.

The current code already has boundary concepts such as an allowed file area,
outside-file read/write flags, sensitive local paths, trusted/restricted modes,
and skill preapproval rules. The new model must preserve those safety
properties:

- a generic `Edit local documents = Allow` rule only applies inside the allowed
  file area;
- reads or writes outside the allowed file area must be a separate action kind
  or a hard block, never silently covered by generic local read/write rules;
- sensitive local paths such as credentials, `.env` files, keychains, SSH keys,
  and package registry tokens must be separate high-risk action kinds or hard
  blocks;
- existing restricted-mode denies must remain in force during migration until
  equivalent global action-kind rules exist;
- skill preapproval metadata may narrow what a skill can do, but it must not
  bypass path boundaries or platform hard blocks.

This keeps "one global permission table" as the user-facing management model
without turning global rules into broad filesystem capabilities.

## Global Permission Rules

The permission store is a single global map:

```ts
interface GlobalToolPermissionRule {
  actionKind: AgentToolActionKind;
  decision: GlobalToolPermissionDecision;
  updatedAt: number;
}
```

No session state is stored. No workspace-specific override is stored. A pending
dialog can still be approved or denied once, but that does not create a stored
permission rule unless the user explicitly chooses an "always" action.

The permission center should show all supported action kinds, their current
decision, and enough examples for the user to understand what each rule covers.
High-risk `allow` choices should be visually explicit, because they apply
globally.

If a user does not want confirmation for a risky action kind, the answer is to
change that global rule to `allow`. The model should not bypass confirmation by
adding metadata to the tool call, and the runtime should not silently create
temporary grants.

The global permission store is not a blocklist. It stores only whether a
supported action kind can run without asking (`allow`) or must ask (`ask`).
Platform hard blocks live outside the user permission table.

## Confirmation Dialog

A confirmation dialog is not a notification and not a timer. It means:

```txt
This action will not run until the user makes a decision.
```

Dialog buttons:

```txt
[Approve once] [Always allow this kind] [Deny once]
```

`Always allow this kind` updates the global permission rule for the action kind.
The once buttons only resolve the pending tool call and are recorded in the
event log. There is intentionally no `Always deny this kind` button; persistent
denial is a platform/tool-availability concern, not a normal user permission
rule.

The dialog should show:

- the action kind;
- the concrete command or target action;
- the runtime-derived consequence;
- whether the action is reversible;
- whether the action affects external systems.

The dialog should not mention countdowns or imply that silence will approve.

If one tool call contains multiple action kinds, the dialog should identify the
action kind that forced the prompt and show the other material effects in
details. The user should not see "read local data" as the headline for a command
that also publishes to a remote service.

## Denied Results

Only platform hard blocks and explicit `Deny once` choices return denied
results. They should return structured data to the agent:

```ts
interface ToolDeniedResult {
  ok: false;
  kind: 'permission_denied';
  primaryActionKind: AgentToolActionKind;
  actionKinds: AgentToolActionKind[];
  reason: 'platform_hard_block' | 'user_denied';
  message: string;
}
```

The agent should treat this as a normal tool result. It can continue with a
fallback, explain what could not be done, or ask the user in chat to change the
global permission if the action is essential.

This matters more than countdowns for unattended work. A denied result lets the
run keep moving when the user or product boundary has already decided that the
current action should not run.

## Platform Hard Blocks

Some actions are outside user-configurable permission policy. They should remain
hard-blocked even if a global rule is set to `allow`.

Examples:

- invalid tool schema;
- unknown tool;
- aborted run;
- disallowed access outside the allowed file area;
- permission self-modification by the agent;
- commands that attempt to destroy the host machine or bypass app safety
  boundaries;
- access to secrets or credentials that are not explicitly exposed through a
  supported tool contract.

These are product safety boundaries, not prompts. They should return
`platform_hard_block` results rather than asking the user to approve them.

## Agent Behavior

The agent should not decide whether approval is required before calling a tool.
It should call the tool it needs for the task. The runtime handles permission.

Agent guidance should instead say:

- use tools normally when they are needed for the task;
- if a tool returns `permission_denied`, continue with a fallback when possible;
- if the denied action is essential, explain the required global permission to
  the user;
- do not try to bypass denied actions by using a lower-level tool;
- do not ask the user to approve routine work in chat when a tool would have
  been allowed by policy.

This keeps the model's job focused on task execution rather than permission
protocol bookkeeping.

## Event Log

Permission events should record the product decision source:

```ts
interface ToolPermissionCheckedEvent {
  type: 'tool.permission.checked';
  requestId: string;
  toolName: string;
  primaryActionKind: AgentToolActionKind;
  actionKinds: AgentToolActionKind[];
  outcome: ToolPermissionOutcome;
  source: 'global_rule' | 'default_rule' | 'platform_hard_block';
  descriptorRef?: AgentPayloadRef;
}
```

```ts
interface ToolPermissionResolvedEvent {
  type: 'tool.permission.resolved';
  requestId: string;
  approved: boolean;
  resolvedBy: 'user_once' | 'allow_rule_update' | 'abort';
  updatedRule?: GlobalToolPermissionRule;
}
```

There are no timeout fields because silence is not a permission decision.

## Relationship To Current Code

Today `src/main/agentPermissions.ts` computes `allow | ask | deny` from a
TypeScript policy. This plan keeps that overall runtime responsibility but
changes the model:

```txt
current:
tool policy matrix -> allow / ask / deny

proposed:
tool action descriptor -> hard block check -> global permission rule -> allow / ask
```

The difference is that the decision should be user-manageable and action-kind
based, not a hidden one-off prompt matrix. Runtime rules are still necessary;
they are just product permission rules rather than agent-authored approval
requests.

## Migration Notes

This plan supersedes the previous action-decision timeout design:

- remove `approval_request` from the proposal;
- do not add approval metadata to tool schemas;
- do not implement timeout approval or timeout denial;
- do not add session-scoped permission grants;
- keep explicit confirmation only for `ask`;
- implement a global permission center as the user-facing source of truth.

P0 should start with a small set of high-confidence action kinds. It is better
to classify fewer things well than to create a broad classifier that asks too
often or silently allows ambiguous actions.

## Implementation Checklist

1. Define `AgentToolActionKind`, `GlobalToolPermissionDecision`,
   `ToolPermissionOutcome`, and `ToolActionDescriptor` in shared TypeScript
   types.
2. Add a global permission store with one `allow | ask` rule per supported
   action kind.
3. Add a permission center UI for viewing and editing the global rules.
4. Build descriptor resolvers for existing agent tools.
5. Preserve existing path-boundary, sensitive-path, restricted-mode, and skill
   preapproval safety properties while mapping them into action descriptors or
   platform hard blocks.
6. For `bash`, classify known command families first, evaluate compound
   commands by the most restrictive segment, and map unknown commands to a
   conservative action kind.
7. Replace hidden `ask` prompts with global-rule-backed permission checks.
8. Update the approval dialog to remove countdowns and session-scope language.
9. Add "approve once", "deny once", and "always allow this kind" resolution
   paths.
10. Return structured `permission_denied` tool results for user-denied and
    hard-block cases.
11. Update agent instructions so denied results are handled as normal tool
    results with fallbacks.
12. Add event log entries for permission checks and user resolutions.
13. Add tests for default allow, explicit ask, approve once, deny once, always
    allow, platform hard blocks, denied-result fallback, path boundaries,
    restricted mode, and shell compound-command classification.

## Open Questions

- What is the initial global default for dependency installation?
- Which local editing operations are reversible enough to default to `allow`?
- Which unknown shell commands are plausible user-owned actions that should ask,
  and which should be platform hard blocks?
- Should repeated identical `ask` actions in one run be coalesced in the UI
  without creating a session permission grant?
- Should project script execution default to `allow` for productivity or `ask`
  because it is arbitrary local code execution?
- Which permission categories should be visible in the first version of the
  permission center?
