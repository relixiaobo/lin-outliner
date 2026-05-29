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

## User Approval Contract

Important tools may accept an optional `user_approval` parameter:

```ts
interface UserApprovalParameter {
  default_on_timeout: 'approve' | 'deny';
  reason: string;
}
```

The model-facing name is intentionally `user_approval`, not `actionDecision`.
From the agent's perspective the action is already expressed by the surrounding
tool call. The extra parameter is only for cases where the agent wants a user
approval window before that concrete action resolves. The lower snake case also
matches the rest of Lin's tool parameter surface.

The field has only three states:

```txt
no user_approval
  -> no agent-requested interruption

default_on_timeout: 'approve'
  -> show an approval card; if the user does nothing, approve after the timeout

default_on_timeout: 'deny'
  -> show an approval card; if the user does nothing, deny after the timeout
```

There is intentionally no `allow`, `notify`, or standalone `deny` state:

- `allow` is the absence of `user_approval`.
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

agent user_approval
  -> countdown protocol

no user_approval and no hard block
  -> run immediately
```

Legacy `ask` rules should be removed only when the corresponding tool guidance
and `user_approval` support are strong enough that the rule no longer carries
the product experience.

### Timeout Duration

The runtime, not the agent, owns the deadline. v1 uses one fixed timeout:

```ts
const USER_APPROVAL_TIMEOUT_SECONDS = 90;
```

The agent chooses the default outcome and writes the reason. It does not choose
the length of the user's intervention window. This keeps the UI predictable and
prevents `default_on_timeout: 'approve'` with a 1 second timer from becoming a
silent bypass.

The timeout can later become a user setting or runtime policy, but it should not
be model-authored in v1.

### Parameter Description

The tool schema should give the agent direct guidance, not just types:

```ts
user_approval: {
  type: 'object',
  description: [
    'Optional. Include only when this exact tool action should give the user a confirmation window.',
    'Omit for routine actions that should run without interruption.',
    'Use default_on_timeout="approve" when you believe the action should run, but the user may want a chance to stop it.',
    'Use default_on_timeout="deny" when the action may be appropriate, but should require explicit user consent if the user is present.',
    'Do not use this for actions you believe should not be done; choose a different approach instead.',
    'The runtime owns the timeout length. Provide only the default outcome and a concise consequence-oriented reason.',
  ].join(' '),
  additionalProperties: false,
  required: ['default_on_timeout', 'reason'],
  properties: {
    default_on_timeout: {
      type: 'string',
      enum: ['approve', 'deny'],
      description: [
        'What happens if the user does not respond within the runtime timeout.',
        'approve means proceed by default; deny means do not run unless the user explicitly approves.',
      ].join(' '),
    },
    reason: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: [
        'One concise sentence explaining the concrete consequence that makes user approval useful.',
        'Do not restate the command; explain why the user might care.',
      ].join(' '),
    },
  },
}
```

Examples:

```json
{
  "command": "bun add zod",
  "user_approval": {
    "default_on_timeout": "approve",
    "reason": "This dependency is needed for the implementation and only changes local project files."
  }
}
```

```json
{
  "command": "git push origin codex/agent-action-decision-doc",
  "user_approval": {
    "default_on_timeout": "deny",
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
targetTool({ ...targetArgs, user_approval })
```

The action and the agent's attention policy are emitted atomically in the same
tool call.

## Runtime Responsibilities

The runtime's job is mechanical, not judgmental:

1. Extract `user_approval` before executing the tool.
2. Run the platform safety floor and any temporary legacy policy still active
   during migration.
3. If `user_approval` is absent and no runtime block applies, run the tool
   normally.
4. If present, create an approval request with the fixed 90 second deadline.
5. Resolve the request from user input, session approval, abort, or timeout.
6. On approved, strip `user_approval` from the tool arguments and execute the
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

Will approve in 90s.

[Approve now] [This session] [Deny]
```

Auto-deny example:

```txt
Push branch to GitHub?
git push origin codex/agent-action-decision-doc

The agent says this publishes local commits to the remote repository and should
only happen with explicit user approval.

Will deny in 90s.

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

For `default_on_timeout: 'deny'`, session approval means the user has explicitly
granted that class of action for the current session. Without that explicit
grant, the default remains fail-closed.

Subagent requests bubble through the parent approval path. The card should label
which agent requested the action, and any session rule should stay scoped to the
parent run/session rather than becoming a persistent tool permission.

### User-Owned No-Confirm Mode

Some users will explicitly want the agent to proceed without confirmation, even
for actions that the agent would normally mark with `user_approval`.

That should be a user-owned runtime setting or session rule, not a model-owned
choice:

```txt
normal
  -> honor user_approval countdowns

auto-approve user approval requests
  -> resolve user_approval immediately as approved
```

In auto-approve mode, the agent should still include `user_approval` when it
believes a confirmation window would normally be appropriate. The field remains
useful for audit, transcript clarity, and for users who later turn the mode off.
The runtime simply resolves the request immediately according to the user's
explicit preference.

This setting may approve both `default_on_timeout: 'approve'` and
`default_on_timeout: 'deny'` requests, because the user is intentionally saying
they do not want confirmation. It must still not bypass the platform safety
floor: unknown tools, invalid schema, workspace-boundary violations, hard deny
rules, and permission self-modification remain blocked.

The first implementation should prefer a session-scoped no-confirm switch over a
persistent global switch. A persistent version can be added later, but it should
be visible in the UI while active and recorded in approval events.

## Event Log Changes

`approval.requested` should capture the default behavior and deadline:

```ts
interface ApprovalRequestedEvent {
  type: 'approval.requested';
  requestId: string;
  summary: string;
  defaultOnTimeout?: 'approve' | 'deny';
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
  resolvedBy?: 'user' | 'session' | 'user_setting' | 'timeout' | 'abort' | 'runtime';
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

They can continue to omit `user_approval` and run immediately.

Tools that can benefit from optional `user_approval`:

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
withUserApprovalParameter(tool)
```

The wrapper can:

- add the optional schema property;
- extract and validate `user_approval` in `beforeToolCall`;
- pass cleaned arguments to the real tool executor;
- keep tool implementations focused on their domain behavior.

## Relationship To Current Permission Policy

Today `src/main/agentPermissions.ts` computes `allow | ask | deny` from
TypeScript policy. This plan changes the attention-management path:

```txt
current:
runtime classifies action -> ask -> user approves/denies

proposed:
agent attaches user_approval -> runtime runs countdown protocol
```

This does not require deleting all existing permission code in one step. A
migration can keep legacy ask rules as a fallback while the agent prompt and
tool schemas are updated. The end-state for this proposal is that common
user-attention decisions come from `user_approval`, not a runtime ask matrix.

## Safety Model

This is not a security classifier.

If the agent omits `user_approval`, the action does not receive an
agent-requested interruption window. That is an intentional product tradeoff:
the system optimizes for agent autonomy and avoids blocking on routine work.
Safety still depends on the platform safety floor, model behavior, task
instructions, reversibility/undo where available, and any hard blocks defined
outside this attention policy.

The benefit is that no runtime rule has to guess whether the user's attention is
needed. The agent owns that decision because it knows the task intent.

## Implementation Checklist

1. Define `UserApproval` in a shared main/core type location.
2. Add a registry helper that injects optional `user_approval` into selected
   tool schemas.
3. Update the agent system prompt/tool guidance to explain the three states:
   no decision, timeout approve, timeout deny.
4. Define the platform safety floor that `user_approval` cannot bypass:
   invalid tool/schema, abort, workspace boundary, hard deny, and permission
   self-modification.
5. In `beforeToolCall`, extract `user_approval` before legacy permission
   evaluation, but keep the platform safety floor above it.
6. Use the fixed 90 second runtime timeout when creating approval requests.
7. Extend `requestToolApproval` to accept `defaultOnTimeout` and `deadlineAt`.
8. Preserve `once | session` approval behavior for countdown cards.
9. Add a user-owned session-scoped no-confirm mode that immediately approves
   `user_approval` requests without bypassing the platform safety floor.
10. Add renderer countdown UI to `AgentApprovalCard`, including pause/resume
   semantics.
11. Append timeout metadata to `approval.requested` and `resolvedBy` to
   `approval.resolved`.
12. On timeout-deny, return a normal denied tool result to the agent instead of
    leaving the run blocked.
13. Strip `user_approval` before invoking the underlying tool executor.
14. Add tests for absent approval, hard-block precedence, fixed timeout,
    timeout approve, timeout deny, user override, session approval,
    user-setting approval, abort, and stale request resolution.

## Open Questions

- Should `user_approval` be allowed inside skill shell commands, and if so what
  syntax carries the metadata?
- Which legacy `ask` rules should be removed first after the agent prompt and
  schemas support `user_approval`?
