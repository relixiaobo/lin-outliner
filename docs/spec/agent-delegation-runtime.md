# Agent Delegation Runtime

The delegation runtime is an internal execution engine. It is not a product
concept and it is not a model-facing tool family.

Current product work-management concepts are:

- **Issue**: durable work definition.
- **Recurring Issue**: durable recurrence definition that materializes concrete
  Issues at due time.
- **Agent Session**: one execution attempt against an Issue snapshot.
- **Activity**: append-only evidence and audit trail for Issues, Recurring
  Issues, and Agent Sessions.

The runtime may still create internal delegated execution records because the
existing event-log, transcript, verifier, notification, and isolated-skill
machinery are built around that executor. Agents do not start, inspect, steer,
amend, or stop those records through direct Run tools. They use Issue and Agent
Session tools.

## Boundaries

- There is still exactly one built-in assistant, **Neva**.
- Delegation creates same-agent execution workers, not independent personas,
  team members, or user-visible assignees.
- Direct delegated-Run tools are not in the agent tool catalog.
- The permission model does not expose delegated-run action kinds.
- Tool-call UI does not special-case delegated-run tool names.
- Runtime actor names for this internal path use `internal_delegation`, not a
  model-facing tool name.

## Entry Points

Allowed runtime entry points:

- `agent_session_start` starts execution for an eligible Issue. Runtime maps the
  Agent Session snapshot into an internal delegation input.
- `agent_session_read`, `agent_session_send_message`, and `agent_session_stop`
  inspect or control the Agent Session surface. They may call the internal
  executor behind the boundary, but they never expose executor ids as the public
  control contract.
- Isolated skills use the internal executor to run skill content in a sidechain
  worker and return the final result to the parent skill invocation.

Not allowed:

- A model-facing tool that directly creates an internal delegated worker.
- A model-facing tool that directly reads, messages, amends, or stops an
  internal delegated worker.
- Compatibility profiles that re-enable retired delegated-run tools.
- Node-owned schedule, execution, or watermark protocols.

## Execution Model

An internal delegated worker has:

- a runtime record with status, objective text, criteria, context mode, budget,
  profile, parent linkage, and result/error metadata;
- its own event-log ledger and transcript;
- optional verifier workers;
- optional child workers created by runtime policy, not by a public tool family;
- terminal notification and Activity synchronization through the owning Agent
  Session.

The executor supports three context modes:

- `full`: copy the current parent context, closing unresolved tool calls with
  placeholder results before the worker prompt;
- `brief`: include a compact recent parent-context excerpt;
- `none`: start with only the worker directive and objective.

Verifier workers are runtime-pinned to minimal context.

## Issue Session Mapping

When `agent_session_start` is approved and eligible:

1. Runtime creates or updates the Agent Session record.
2. Runtime resolves the Issue snapshot into a delegation input:
   objective, criteria, input scope, execution policy, profile, and verification
   policy.
3. Runtime starts the internal worker and binds the Agent Session to the
   executor id.
4. Worker progress, result, failure, cancellation, and verifier verdicts are
   copied back to Activity and Session state.
5. The model continues to interact through Agent Session tools, not through the
   executor id.

## Decomposition

When an Agent Session worker needs to split durable work, it should create
sub-Issues through `issue_create` and set the parent relation. Runtime trigger
rules decide whether those sub-Issues start immediately, wait for dependencies,
or wait for a schedule.

This is intentionally different from recursive public delegation. The durable
graph is an Issue hierarchy; execution attempts are Agent Sessions bound to
those Issues. Control and result acceptance are adjacent-only: a sub-Issue
records Activity and Agent Session output on itself, its direct parent accepts or
summarizes that result, and each parent repeats that step upward. A descendant
does not directly notify chat or bypass ancestor Issues. State can still roll up
recursively through parent search rows, so a top-level Issue can show compact
progress for the whole descendant tree without exposing every sub-Issue as a
first-level Work row.

## Verification

Verification remains an execution policy, not a separate model-facing tool.

- A verified worker must have explicit criteria.
- Runtime may start verifier workers using the configured verifier profile.
- Accepted verifier results are recorded as Activity on the Issue.
- A rejected worker can create replacement work when budget and livelock guards
  allow it.
- A verifier verdict does not automatically complete the Issue; Issue completion
  is a durable lifecycle decision recorded through Issue state and Activity.

## Isolated Skills

`execution: isolated` skills use the same internal executor with a narrow input:

- objective is the rendered skill body;
- verification is off unless the skill flow explicitly adds it through ordinary
  work criteria;
- read-only isolated skills receive a read-only filtered tool set;
- the parent receives only the final result and durable output references.

The skill surface does not require, describe, or expose direct delegated-run
tools.

## Debug Surfaces

Internal delegated execution can still appear in debug and transcript views
because those views inspect runtime process state. Those views are diagnostic;
they are not the product work-management vocabulary and do not define agent tool
contracts.
