# Agent Subagent Threads

A Subagent is a child Thread. It is not a durable Agent object, membership
record, or special execution store.

## Lineage

`parentThreadId` records Subagent lineage. Root and descendants share a
`sessionId`. `forkedFromId` records history-fork lineage and is independent of
Subagent lineage.

Each child has its own catalog record, rollout, Turns, Items, active-Turn lock,
Goal, and extension state. Parent and child communicate through canonical Items
and a host mailbox; they never share mutable Turn history.

## Roles And Configuration

A Configuration Profile defines root execution defaults. An Agent Role narrows
or specializes a child execution. A Subagent is the child Thread created with
that resolved Role.

Child resolution applies the parent as a hard ceiling across every capability
source:

- model tools
- Skills
- plugins
- MCP servers

Role overrides may remove parent capabilities but cannot add capabilities the
parent did not have. Model and reasoning-effort overrides remain explicit child
configuration choices. Resume resolves the stored Role again and reapplies the
current parent ceiling and explicit blocks.

Built-in Roles are `default`, `worker`, and `explorer`. Project or user Roles use
the same contract and do not introduce a second kind of Agent identity.

## Collaboration Tools

The fixed `collaboration` namespace contains:

- `collaboration.spawn_agent`: create a child Thread and start its first Turn
- `collaboration.send_message`: queue a message without forcing a new Turn
- `collaboration.followup_task`: start work when idle or deliver at a safe active
  boundary
- `collaboration.wait_agent`: wait for child activity or a bounded timeout
- `collaboration.list_agents`: query the live descendant tree
- `collaboration.interrupt_agent`: interrupt a child's current Turn

Providers that require flat names receive the reversible `namespace__name`
encoding. Registry assembly rejects any collision before a tool reaches a model.

Task paths are host-session addresses such as `/root/research`. They route live
coordination and are not durable entity IDs. Durable relationships use Thread
IDs.

## History And Activity

Spawning records a `collabAgentToolCall` in the sender and a
`subAgentActivity` edge for child lifecycle changes. Child output remains in the
child rollout. Parent-visible summaries are Items, not copied child history.

Waiting is interruptible and returns on mailbox activity, child completion,
steered root input, or timeout. Interrupt changes only the active child Turn and
retains the Thread for follow-up work.

An isolated Skill uses the same child-Thread mechanism with a bounded tool
catalog. Read-only isolation is a catalog constraint, not an operating-system
sandbox.
