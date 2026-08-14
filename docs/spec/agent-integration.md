# Agent Integration

This document defines the checks a capability must satisfy when integrating with
Agent Core. It is a contract checklist, not project status.

## Core Contract

- Use Thread, Turn, Item, Goal, Role, and Subagent as the product vocabulary.
- Cross the strict request/response codecs; do not add parallel IPC.
- Persist execution history only through canonical notifications and rollouts.
- Give every completed fact immutable provenance.
- Keep one active Turn per Thread and require exact identity preconditions.
- Preserve history-only fork semantics.
- Represent each Agent as a child Thread plus one stable Agent execution ID;
  deliver background completion only to its direct parent.
- Route scheduled work through Automation claims and canonical feature Turn
  provenance; do not add another execution scheduler.

## Tool Contract

- Register one collision-free canonical identity and complete schema.
- Keep the Agent orchestration surface to `agent`, `agent_message`, and unified
  `task_stop`; do not add a roster, inbox, follow-up, wait, or polling alias.
- Declare Core scope and action kinds.
- Apply effective configuration and parent capability ceilings.
- Return native structured unavailable or failure results.
- Emit one started and one terminal Item.
- Attach Thread/Turn/Item causation to document mutations.
- Keep visible output bounded without discarding durable details.
- Start every new Agent from fresh context; reuse its own history only when the
  same stable ID is resumed.

## Extension Contract

- Register through `ExtensionRegistry`.
- Own extension state outside Core stores.
- Snapshot admission state before a Turn becomes durable.
- Use host or per-Thread barriers for configuration changes.
- Reconcile orphan extension state on startup.
- Contribute context or terminal Items through typed hooks.
- Use trusted document transactions for atomic Node plus receipt publication.

## Renderer Contract

- Render canonical DTOs directly.
- Store identity and pagination state in `threadStore`.
- Decode notifications before state mutation.
- Use shared dialogs, menus, icons, tokens, and i18n.
- Cover empty, idle, active, failed, interrupted, and input-request states.
- Derive Agent rows from canonical lineage, execution generation, child Turn,
  and pending-notification state, never a model wait Item.
- Verify light and dark appearance for changed surfaces.

## Persistence Contract

- Add no alternate history ledger.
- Keep rollout JSONL append-only and projections rebuildable.
- Keep feature stores explicitly owned and keyed by canonical IDs.
- Persist Agent identity, recorded configuration, stop provenance, retained
  worktree metadata, and pending `{agentId, generation}` delivery without adding
  a second transcript.
- Serialize Automation claims with pause, delete, Start now, and dispatch; keep
  Memory eligibility based on immutable Turn provenance.
- Test crash recovery and idempotent reconciliation.
- Verify a fresh userData tree contains only declared current artifacts.

## Verification Contract

- Add protocol codec and invalid-state tests.
- Add lifecycle and restart tests for persistent behavior.
- Add renderer tests for each visible canonical state.
- Add E2E coverage for the user workflow.
- Keep the active repository residue guard clean.
- Run typecheck, Core tests, renderer tests, E2E, docs check, and diff check
  before the PR is ready.
