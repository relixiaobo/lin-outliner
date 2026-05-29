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
actions the product should not take autonomously should be denied without a
dialog, and only genuinely user-owned decisions should ask.

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
   personally make the decision. Otherwise the runtime should `allow` or `deny`
   without interrupting.

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
Run local validation commands            Allow
Install dependencies                     Allow / Ask / Deny
Delete local data                        Ask / Deny
Publish to a remote service              Ask / Deny
Send external messages                   Ask / Deny
Payment or purchase actions              Deny
Modify agent permission settings         Deny
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
  -> derive action kind from tool name and arguments
  -> read global permission rule for that action kind
  -> allow: execute immediately
  -> deny: return a structured denied result to the agent
  -> ask: show a confirmation dialog and wait for explicit user input
```

`ask` is allowed to block, because it means the product genuinely needs the
user's decision. The way to protect unattended runs is to avoid classifying
routine actions as `ask`.

`ask` is not the fallback for runtime uncertainty. If an action is unknown,
ambiguous, or outside the supported classification surface, the product should
prefer `deny` unless the action category is important enough that the user must
decide. This keeps popups meaningful instead of turning them into a generic
"runtime is unsure" bucket.

## Action Kinds

Permission rules should be based on action kind, not raw tool name.

`bash` is the clearest example:

```txt
bash: rg TODO src
  -> read/search local data

bash: bun test
  -> run local validation command

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

Sketch:

```ts
type ToolPermissionDecision = 'allow' | 'ask' | 'deny';

interface ToolActionDescriptor {
  toolName: string;
  actionKind: AgentToolActionKind;
  title: string;
  summary: string;
  consequence: string;
  defaultDecision: ToolPermissionDecision;
  reversible: boolean;
  externalEffect: boolean;
}
```

The descriptor is product data. It is derived by runtime/tool code from the
actual call. It is not supplied by the model.

## Global Permission Rules

The permission store is a single global map:

```ts
interface GlobalToolPermissionRule {
  actionKind: AgentToolActionKind;
  decision: ToolPermissionDecision;
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

## Confirmation Dialog

A confirmation dialog is not a notification and not a timer. It means:

```txt
This action will not run until the user makes a decision.
```

Dialog buttons:

```txt
[Approve once] [Always allow this kind] [Deny once] [Always deny this kind]
```

The "always" buttons update the global permission rule for the action kind. The
"once" buttons only resolve the pending tool call and are recorded in the event
log.

The dialog should show:

- the action kind;
- the concrete command or target action;
- the runtime-derived consequence;
- whether the action is reversible;
- whether the action affects external systems.

The dialog should not mention countdowns or imply that silence will approve.

## Denied Results

`deny` should not open a dialog. It should return a structured result to the
agent:

```ts
interface ToolDeniedResult {
  ok: false;
  kind: 'permission_denied';
  actionKind: AgentToolActionKind;
  reason: 'global_rule' | 'platform_hard_block' | 'user_denied';
  message: string;
}
```

The agent should treat this as a normal tool result. It can continue with a
fallback, explain what could not be done, or ask the user in chat to change the
global permission if the action is essential.

This matters more than countdowns for unattended work. A denied result lets the
run keep moving when the product can already decide that the action should not
run.

## Platform Hard Blocks

Some actions are outside user-configurable permission policy. They should remain
hard-blocked even if a global rule is set to `allow`.

Examples:

- invalid tool schema;
- unknown tool;
- aborted run;
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
  actionKind: AgentToolActionKind;
  decision: ToolPermissionDecision;
  source: 'global_rule' | 'default_rule' | 'platform_hard_block';
  descriptorRef?: AgentPayloadRef;
}
```

```ts
interface ToolPermissionResolvedEvent {
  type: 'tool.permission.resolved';
  requestId: string;
  approved: boolean;
  resolvedBy: 'user_once' | 'global_rule_update' | 'abort';
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
tool action descriptor -> global permission rule -> allow / ask / deny
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

1. Define `AgentToolActionKind`, `ToolPermissionDecision`, and
   `ToolActionDescriptor` in shared TypeScript types.
2. Add a global permission store with one rule per supported action kind.
3. Add a permission center UI for viewing and editing the global rules.
4. Build descriptor resolvers for existing agent tools.
5. For `bash`, classify known command families first and map unknown commands to
   a conservative action kind.
6. Replace hidden `ask` prompts with global-rule-backed permission checks.
7. Update the approval dialog to remove countdowns and session-scope language.
8. Add "approve once", "deny once", "always allow this kind", and "always deny
   this kind" resolution paths.
9. Return structured `permission_denied` tool results for `deny` and hard-block
   cases.
10. Update agent instructions so denied results are handled as normal tool
    results with fallbacks.
11. Add event log entries for permission checks and user resolutions.
12. Add tests for default allow, default deny, explicit ask, approve once, deny
    once, always allow, always deny, platform hard blocks, denied-result
    fallback, and shell command classification.

## Open Questions

- What is the initial global default for dependency installation?
- Which local editing operations are reversible enough to default to `allow`?
- Should unknown shell commands default to `ask` or `deny`?
- Which permission categories should be visible in the first version of the
  permission center?
