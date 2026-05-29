---
status: draft
priority: P0
owner: relixiaobo
created: 2026-05-29
updated: 2026-05-29
---

# Agent Action Decision Timeouts

This plan changes approvals from a runtime-owned safety classifier into an
agent-owned attention contract attached to a concrete action.

The goal is not to make Lin better at interrupting the user. The goal is to keep
agent work moving when the user steps away, while still giving the user a clear
chance to intervene on actions the agent itself believes need human attention.

This mainly helps actions where the agent is inclined to proceed and only wants
to give the user an interruption window. Actions that require explicit consent,
such as publishing to a remote, still fail closed when the user is absent; the
improvement is that they return a denied result to the agent instead of leaving
the whole run stuck forever.

## Problem

The current approval model blocks the run on `ask`. This fails in two common
ways:

- The user rubber-stamps most prompts, so the prompt stops carrying useful
  signal.
- The user starts a large task, leaves, and returns later to find the agent
  blocked near the beginning on an approval request.

A smarter TypeScript risk matrix does not solve the product problem by itself.
The agent usually understands the intent of the action better than a shallow
runtime rule does. For example, the important question is not "is `bash`
dangerous?" It is "should this exact command, in this task, proceed without
waiting for the user?"

## Design Principle

The decision is attached to the intended action, not the tool.

The same tool can run silently, run with an auto-approve countdown, or wait for
explicit approval depending on what the agent is trying to do:

```txt
bash: rg TODO src
  -> no decision, run immediately

bash: bun add zod
  -> countdown defaults to approve

bash: git push origin codex/foo
  -> countdown defaults to deny
```

The runtime does not classify task risk. It executes the action-decision
protocol when the agent provides one.

This proposal still assumes a platform safety floor below the attention policy:
unknown tools, invalid schemas, aborts, workspace-boundary violations, and
non-negotiable hard blocks stay runtime-enforced. That safety floor is not a
runtime attempt to decide whether the user should be bothered; it is the product
boundary that a model-authored decision cannot override.

## Action Decision Contract

Important tools may accept an optional `actionDecision` parameter:

```ts
interface ActionDecision {
  timeoutDefault: 'approve' | 'deny';
  timeoutSeconds: number;
  reason: string;
}
```

The field has only three states:

```txt
no actionDecision
  -> no agent-requested interruption

timeoutDefault: 'approve'
  -> show an approval card; if the user does nothing, approve after the timeout

timeoutDefault: 'deny'
  -> show an approval card; if the user does nothing, deny after the timeout
```

There is intentionally no `allow`, `notify`, or standalone `deny` state:

- `allow` is the absence of `actionDecision`.
- `notify` creates noise the user is unlikely to care about later.
- A true "do not do this" decision should simply avoid the tool call; `deny`
  default means "this may be the right action, but it requires explicit user
  consent."

Absence does not bypass the platform safety floor. During the P0 migration,
absence also falls back to the existing legacy permission policy for tools that
still have hard-coded `ask` rules. The end-state is:

```txt
runtime hard block
  -> always block

agent actionDecision
  -> countdown protocol

no actionDecision and no hard block
  -> run immediately
```

Legacy `ask` rules should be removed only when the corresponding tool guidance
and `actionDecision` support are strong enough that the rule no longer carries
the product experience.

### Timeout Bounds

The runtime, not the agent, owns the actual deadline. `timeoutSeconds` is an
agent request that must be clamped to product bounds:

```ts
const ACTION_DECISION_TIMEOUT_MIN_SECONDS = 10;
const ACTION_DECISION_TIMEOUT_MAX_SECONDS = 120;
```

Values below the minimum are raised to the minimum. Values above the maximum are
lowered to the maximum. Missing, non-finite, or invalid values reject the
`actionDecision` and return a recoverable tool-input error asking the agent to
retry with a valid timeout.

This prevents `timeoutDefault: 'approve', timeoutSeconds: 1` from becoming a
silent bypass of the user's intervention window.

Examples:

```json
{
  "command": "bun add zod",
  "actionDecision": {
    "timeoutDefault": "approve",
    "timeoutSeconds": 30,
    "reason": "This dependency is needed for the implementation and only changes local project files."
  }
}
```

```json
{
  "command": "git push origin codex/agent-action-decision-doc",
  "actionDecision": {
    "timeoutDefault": "deny",
    "timeoutSeconds": 60,
    "reason": "This publishes local commits to the remote repository and should only happen with explicit user approval."
  }
}
```

## Why Not A Separate Decision Tool

A separate `DecisionTool` that must be called before the real tool is not a
reliable protocol.

The model has no transaction boundary that guarantees:

```txt
DecisionTool(targetTool, targetArgs, decision)
then
targetTool(targetArgs)
```

The model can forget the first call, change the target args between calls, or
emit the real tool call directly. Runtime enforcement would then have to reject
and ask the model to retry, adding another round trip and recreating the same
blocking failure mode.

The stable version is inline:

```txt
targetTool({ ...targetArgs, actionDecision })
```

The action and the agent's attention policy are emitted atomically in the same
tool call.

## Runtime Responsibilities

The runtime's job is mechanical, not judgmental:

1. Extract `actionDecision` before executing the tool.
2. Run the platform safety floor and any temporary legacy policy still active
   during migration.
3. If `actionDecision` is absent and no runtime block applies, run the tool
   normally.
4. If present, clamp the timeout and create an approval request with a deadline.
5. Resolve the request from user input, session approval, abort, or timeout.
6. On approved, strip `actionDecision` from the tool arguments and execute the
   underlying tool.
7. On denied, return a denied tool result to the agent so it can continue with a
   fallback.
8. Record whether the result came from the user, a session rule, timeout, abort,
   or runtime.

The runtime may still enforce technical invariants such as invalid schema,
unknown tool, abort, missing file, or process failure. Those are execution
constraints, not an action safety classifier.

Non-negotiable hard blocks such as machine-destruction commands, workspace
boundary violations, and permission self-modification are outside this proposal.
They are platform safety boundaries, not user-attention policy.

## Approval UX

The approval card should say what will happen on timeout.

Auto-approve example:

```txt
Install dependency?
bun add zod

The agent says this dependency is needed for the implementation and only changes
local project files.

Will approve in 30s.

[Approve now] [This session] [Deny]
```

Auto-deny example:

```txt
Push branch to GitHub?
git push origin codex/agent-action-decision-doc

The agent says this publishes local commits to the remote repository and should
only happen with explicit user approval.

Will deny in 60s.

[Approve once] [This session] [Deny now]
```

When the user interacts with the card, the countdown should pause so a
near-expired timer does not race the user's decision. "Interacts" means keyboard
focus inside the card, opening details, pressing a button, or pointer down on the
card. Mere pointer hover may pause while the pointer remains over the card, but
leaving the card should resume with at least a 5 second grace window.

### Session Approval

The existing `once | session` approval scope should continue to work.

Session approval creates or reuses a narrow session rule for the resolved
action. A later matching action skips the countdown card and runs immediately,
with `approval.resolved` recorded as session-resolved if an approval event was
already open. The session rule must be derived from the actual tool name and
target arguments, not from the model's `reason`, and must not broaden beyond the
same match rules used today.

For `timeoutDefault: 'deny'`, session approval means the user has explicitly
granted that class of action for the current session. Without that explicit
grant, the default remains fail-closed.

Subagent requests bubble through the parent approval path. The card should label
which agent requested the action, and any session rule should stay scoped to the
parent run/session rather than becoming a persistent tool permission.

## Event Log Changes

`approval.requested` should capture the default behavior and deadline:

```ts
interface ApprovalRequestedEvent {
  type: 'approval.requested';
  requestId: string;
  summary: string;
  timeoutDefault?: 'approve' | 'deny';
  timeoutSeconds?: number;
  deadlineAt?: number;
  payloadRef?: AgentPayloadRef;
}
```

`approval.resolved` should capture who or what resolved it:

```ts
interface ApprovalResolvedEvent {
  type: 'approval.resolved';
  requestId: string;
  approved: boolean;
  resolvedBy?: 'user' | 'session' | 'timeout' | 'abort' | 'runtime';
}
```

Timeout approval must not be recorded as if the user clicked approve.

## Tool Impact

Read-only and retrieval tools do not need this parameter:

- `node_search`
- `node_read`
- `file_read`
- `file_glob`
- `file_grep`
- `web_search`
- `web_fetch`
- `past_chats`

They can continue to omit `actionDecision` and run immediately.

Tools that can benefit from optional `actionDecision`:

- `bash`
- `file_edit`
- `file_write`
- `node_create`
- `node_edit`
- `node_delete`
- `operation_history` for undo / redo
- `task_stop` when stopping a user-visible background process
- future browser, computer-use, MCP, email, issue, PR, deploy, or payment tools

Because current schemas use `additionalProperties: false`, supported tools must
explicitly accept the field or be wrapped by a registry helper that injects the
same property into their JSON schema.

Prefer a shared helper instead of hand-editing every schema:

```ts
withActionDecisionParameter(tool)
```

The wrapper can:

- add the optional schema property;
- extract and validate `actionDecision` in `beforeToolCall`;
- pass cleaned arguments to the real tool executor;
- keep tool implementations focused on their domain behavior.

## Relationship To Current Permission Policy

Today `src/main/agentPermissions.ts` computes `allow | ask | deny` from
TypeScript policy. This plan changes the attention-management path:

```txt
current:
runtime classifies action -> ask -> user approves/denies

proposed:
agent attaches actionDecision -> runtime runs countdown protocol
```

This does not require deleting all existing permission code in one step. A
migration can keep legacy ask rules as a fallback while the agent prompt and
tool schemas are updated. The end-state for this proposal is that common
user-attention decisions come from `actionDecision`, not a runtime ask matrix.

## Safety Model

This is not a security classifier.

If the agent omits `actionDecision`, the action does not receive an
agent-requested interruption window. That is an intentional product tradeoff:
the system optimizes for agent autonomy and avoids blocking on routine work.
Safety still depends on the platform safety floor, model behavior, task
instructions, reversibility/undo where available, and any hard blocks defined
outside this attention policy.

The benefit is that no runtime rule has to guess whether the user's attention is
needed. The agent owns that decision because it knows the task intent.

## Implementation Checklist

1. Define `ActionDecision` in a shared main/core type location.
2. Add a registry helper that injects optional `actionDecision` into selected
   tool schemas.
3. Update the agent system prompt/tool guidance to explain the three states:
   no decision, timeout approve, timeout deny.
4. Define the platform safety floor that `actionDecision` cannot bypass:
   invalid tool/schema, abort, workspace boundary, hard deny, and permission
   self-modification.
5. In `beforeToolCall`, extract `actionDecision` before legacy permission
   evaluation, but keep the platform safety floor above it.
6. Clamp `timeoutSeconds` to the product min/max and reject invalid values.
7. Extend `requestToolApproval` to accept `timeoutDefault`, `timeoutSeconds`,
   and `deadlineAt`.
8. Preserve `once | session` approval behavior for countdown cards.
9. Add renderer countdown UI to `AgentApprovalCard`, including pause/resume
   semantics.
10. Append timeout metadata to `approval.requested` and `resolvedBy` to
   `approval.resolved`.
11. On timeout-deny, return a normal denied tool result to the agent instead of
    leaving the run blocked.
12. Strip `actionDecision` before invoking the underlying tool executor.
13. Add tests for absent decision, hard-block precedence, timeout clamp, timeout
    approve, timeout deny, user override, session approval, abort, and stale
    request resolution.

## Open Questions

- Should action decisions be allowed inside skill shell commands, and if so what
  syntax carries the metadata?
- Which legacy `ask` rules should be removed first after the agent prompt and
  schemas support `actionDecision`?
