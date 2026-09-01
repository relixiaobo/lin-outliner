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
- Reach persisted Outliner state only through `bash` and the public `outline`
  CLI; do not add a document-native model tool or private import endpoint.
- Classify Outline shell calls from the executable capability registry and
  require host attestation for built-in Agent mutations.
- Route one complete resource to one porcelain invocation, complex state for
  that resource to the same command's `--input`, and dependent/cross-date/bulk
  work to one ChangeSet with bindings; never use shell mutation loops or
  intermediate created-ID discovery.
- Discover exact syntax and semantics through root/family/command help and
  `outline schema COMMAND`; preserve patch omission, explicit replacement,
  selector cardinality, destructive Diff binding, and idempotent
  set/configure/ensure behavior.
- Keep the Agent orchestration surface to `agent`, `agent_message`, and unified
  `task_stop`; do not add a roster, inbox, follow-up, wait, or polling alias.
- Declare Core scope and action kinds.
- Apply effective configuration and parent capability ceilings.
- Return native structured unavailable or failure results.
- Emit one started and one terminal Item.
- Attach Thread/Turn/Item causation to the Runtime Operation, not to a parallel
  Agent document schema.
- Keep visible output bounded without discarding durable details.
- Let a resolved tool opt specific canonical RFC 6901 string paths into the
  shared large-text contract. Keep exact UTF-8 dependencies Thread-private,
  replay them exactly for the provider, and use bounded projections for display.
- Treat Bash `stdin` as literal foreground UTF-8 data, not shell syntax. Classify
  its effective consumer from the command once, keep the payload opaque to
  permissions, and reject background input before spawn.
- Start every new Agent from fresh context; reuse its own history only when the
  same stable ID is resumed.
- For historical context, expose bounded lazy `thread_search` / `thread_read`
  facades rather than renderer history IPC or eager transcript injection. Keep
  same-profile validation, current-Thread exclusion, tool ceilings, action blocks,
  and selected-file read descriptors independent.
- Treat historical titles, snippets, messages, activity summaries, file labels,
  and bounded tool output as untrusted quoted context. A Thread marker, cursor, or
  citation key is identity or lookup state, never authority.

## Extension Contract

- Register through `ExtensionRegistry`.
- Own extension state outside Core stores.
- Snapshot admission state before a Turn becomes durable.
- Use host or per-Thread barriers for configuration changes.
- Reconcile orphan extension state on startup.
- Contribute context or terminal Items through typed hooks.
- Use one idempotent Runtime ChangeSet for atomic Node plus receipt publication;
  settle the feature store from the durable Operation.

## Renderer Contract

- Keep canonical Thread, Turn, and Item authority in main. Render only the
  exhaustively projected renderer DTOs; payload-backed model arguments cross IPC
  as `{ storage: 'itemBound' }`, never as context or internal-text references.
- Resolve payload-backed tool arguments through the enclosing
  `thread/item/arguments/read` identity and accept only main's bounded value.
- Store identity and pagination state in `threadStore`.
- Decode notifications before state mutation.
- Use shared dialogs, menus, icons, tokens, and i18n.
- Store Composer Thread mentions as structured UUIDv7 content; resolve current titles
  for menu, transcript, copy, and history presentation without putting titles in the
  canonical URI. Keep missing/current/corrupt/denied targets non-fatal.
- Cover empty, idle, active, failed, interrupted, and input-request states.
- Derive Agent rows from canonical lineage, execution generation, child Turn,
  and pending-notification state, never a model wait Item.
- Verify light and dark appearance for changed surfaces.

## Persistence Contract

- Add no alternate history ledger.
- Keep document Operation history, recovery patches, and asset reachability in
  the standalone Runtime; Agent stores retain only feature control state.
- Keep immutable exact revisions, admission leases, opaque retention anchors,
  integrity quarantine, and physical GC in neutral `src/content/`. Outline
  AssetRecords and Agent resource-reference records retain those revisions through
  Host-private coordinates. A selected historical citation reuses that Agent resolver
  and working-set contract; it does not create an alternate file or retention store.
- Keep rollout JSONL append-only and projections rebuildable.
- Account content-addressed internal text in the owning Thread quota and carry
  its reachability through fork, child inheritance, rollback, prune, startup
  reconciliation, and Thread deletion.
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
- Verify Thread-reference URI parsing does not expand Outline `ReferenceTarget`,
  and cover Composer keyboard/pointer selection, exact history restore, current-title
  rendering, unavailable targets, bounded history cursors, untrusted framing, and
  page-scoped historical citations.
- Keep the active repository residue guard clean.
- Verify every Core document command has exactly one public capability owner and
  no retired document/import authority remains live.
- Verify help, completion metadata, parser options, and exact command schemas
  derive from one registry and cover root, family, create, leaf-view, and
  destructive help goldens without starting Runtime.
- Verify complete-resource and dependent-resource CLI goldens assert final
  document state, mutation invocation count, Operation count, visible Operation
  ID/affected/recovery data, and guarded exact revert.
- Run typecheck, Core tests, renderer tests, E2E, docs check, and diff check
  before the PR is ready.
