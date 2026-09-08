# Agent Integration

This document defines the checks a capability must satisfy when integrating with
Agent Core. It is a contract checklist, not project status.

## Core Contract

- Treat `config/settings.jsonc` as the sole public model/settings source. Agents
  may edit declarative model connections, model allow-lists, and defaults in
  that JSONC file; credentials, catalog caches, probes, and runtime snapshots
  stay behind their existing owner APIs. No Settings or Configuration CLI is
  part of the contract. Empty connection model lists follow the live catalog;
  non-empty lists are exact allow-lists, and unavailable explicit/default
  models return typed unavailable errors without provider fallback.
- Treat `config/keybindings.jsonc` as the sole desired-state source for
  configurable shortcuts. Its generated `keybindings.schema.json` defines the
  current command IDs, portable chord values, alternates, defaults, and explicit
  disable form. The `keybindings` member of `config/status.json` reports the
  current Host session's observed/accepted source and desired/effective entries,
  including retained system bindings after failed registration. Agents edit the
  public JSONC with ordinary file tools, preserve unrelated text, and verify the
  addressed entry against current-Host status; there is no shortcut tool or
  Settings/Configuration CLI.
- Root Configuration Profiles remain in the layered `agent/config.json` and
  `.tenon/agent.json` sources. Delegation policy is public under
  `agent.delegation`; active pointers, probe/runtime state, and Session bindings
  remain private to their owners. Root and delegation source edits preserve
  existing snapshots and never restore retired Agent-type fields.
- The root configuration owner reports both source paths, schema locations,
  `missing`/`accepted`/`rejected` status, content digest, and bounded parse or
  validation errors through the existing Agent editor view. This is inspection
  data, not a second configuration snapshot.
- Under the workbench refactor, resolve root configuration from its explicitly
  selected source, not a task cwd or newly discovered repository. Project
  grouping alone cannot apply a configuration change; check profiles and Skill
  discovery remain separate scoped inputs.

- Use Thread, Turn, Item, Goal, Tool Task, Agent Session, launcher, and Task Profile
  as distinct product vocabulary.
- Cross the strict request/response codecs; do not add parallel IPC.
- Persist execution history only through canonical notifications and rollouts.
- Give every completed fact immutable provenance.
- Keep one active Turn per Thread and require exact identity preconditions.
- Preserve history-only fork semantics.
- Represent internal delegation as one root-owned Session bound to a hidden
  canonical Thread; keep process and delivery truth in the generic Tool Task.
- Route scheduled work through Automation claims and canonical feature Turn
  provenance; do not confuse scheduled product work with the generic local
  admission leases that bound processes Tool Tasks start.

## Tool Contract

- Register one collision-free canonical identity and complete schema.
- Reach persisted Outliner state only through `bash` and the public `outline`
  CLI; do not add a document-native model tool or private import endpoint.
- Classify Outline shell calls from the executable capability registry and
  require host attestation for built-in Agent mutations.
- Model Node as the only content/tree identity, Field as a reusable definition
  whose values belong to Nodes, View as projection-only configuration, and
  Operation as the settlement/recovery identity.
- Route one complete resource to one semantic invocation, complex state for
  that resource to the same command's `--input`, and only genuinely dependent
  work to one `transact` ChangeSet with bindings; never use shell mutation loops
  or intermediate created-ID discovery.
- Discover syntax progressively through the Skill, one validated example,
  exact command help, and a narrow `outline schema COMMAND --path` fragment.
  Preserve patch omission, explicit replacement, selector cardinality,
  destructive Diff binding, and compatible Field ensure behavior.
- Treat a committed-state verified semantic receipt as proof for its covered
  postconditions. Read again only for facts outside that receipt, and recover
  unknown settlement through exact idempotency history rather than retrying.
- Keep delegation out of the model-tool catalog. Expose it only through the
  built-in Skill, canonical `delegate` CLI commands, and ordinary Bash.
- Run background-capable Bash through durable Tool Tasks. Keep producer tools
  responsible for creating domain work and reserve `task_status` / `task_stop`
  for inspecting or cancelling a returned task handle; do not add `task_start`.
- Persist nonce-bound supervisor identity, quiescent final receipts, admission
  leases, delivery batches, bounded detail, and artifact references. Reconcile
  them before reopening admission after restart, without replaying a command.
- Keep producer output and artifacts untrusted, Host facts observational, and
  fixed completion handling rules instructional. Commit exactly-once delivery
  at canonical `turn/started`, not at an IPC return or model response.
- Declare Core scope and action kinds.
- Apply effective configuration, explicit blocks, and delegated Session ceilings.
- Keep launcher, model, effort, scheduling, timeout, and maximum-access policy in
  Settings. Resolve and snapshot them before admission; reject unavailable
  explicit selections without fallback.
- Return native structured unavailable or failure results.
- Emit one started and one terminal Item.
- Mint a fresh UUIDv7 internal identity for every provider tool call. Keep raw provider
  input and active provider correlation separate; heal empty or repeated correlations
  to the portable internal UUID form in both the active call and result.
- Persist bounded source provider replay metadata only in replayable model-call history.
  Restore it only for an exact same-model projection; derive paired portable IDs and
  remove opaque signatures after any model change.
- Attach Thread/Turn/Item causation to the Runtime Operation, not to a parallel
  Agent document schema.
- Keep visible output bounded without discarding durable details.
- Let a resolved tool opt specific canonical RFC 6901 string paths into the
  shared large-text contract. Keep exact UTF-8 dependencies Thread-private,
  replay them exactly for the provider, and use bounded projections for display.
- Treat Bash `stdin` as literal UTF-8 data, not shell syntax. Classify
  its effective consumer from the command once, keep the payload opaque to
  permissions, and preserve exact bytes for foreground and background tasks.
- Start every new Agent Session from fresh context; reuse only its hidden
  canonical history when the same root-owned Session is explicitly continued.
- For historical context, expose bounded lazy `thread_search` / `thread_read`
  facades rather than renderer history IPC or eager transcript injection. Keep
  same-profile validation, current-Thread exclusion, tool ceilings, action blocks,
  and selected-file read descriptors independent.
- Treat historical titles, snippets, messages, activity summaries, file labels,
  and bounded tool output as untrusted quoted context. A Thread marker, cursor, or
  citation key is identity or lookup state, never authority.
- Keep Skill lifecycle operations in the shared domain owner reached by
  `skill_inspect` / `skill_manage` and human Library IPC. Preferences remain
  file-only; managed records must not gain an enable flag. Recheck exact target,
  current root Turn authority, and operation-specific blocks at delayed commit.
  Keep sender-bound human review distinct from permission policy and separate
  saved content, observed invocation availability, and runtime refresh results.
- Keep Memory management in the shared `memory_inspect` / `memory_manage` owner,
  distinct from file-backed global enablement and ordinary Outline content.
  Exercise exact native-reviewed Reset targets and recovery, retained exclusions,
  root-only late authority checks, Thread revisions, sender isolation, truthful
  navigation/settlement, and event-driven local UI together. No scaffold release
  or Settings CLI is a substitute for the complete workflow.
- Keep application/update and diagnostics actions in the shared
  `application_inspect` / `application_manage` and
  `diagnostics_inspect` / `diagnostics_manage` Host owner. Fresh update checks,
  bundled installed-release information, cached remote-update state, validated
  release destinations, fixed support links, and native diagnostic export are
  distinct outcomes. Revalidate caller authority and the originating Host/window
  after native save interaction and before writing. Never expose an arbitrary
  URL/path input or a Settings/Configuration CLI.

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
  as `{ storage: 'itemBound' }`, never as context or internal-text references, and
  provider replay envelopes never cross IPC.
- Resolve payload-backed tool arguments through the enclosing
  `thread/item/arguments/read` identity and accept only main's bounded value.
- Store identity and pagination state in `threadStore`.
- Decode notifications before state mutation.
- Use shared dialogs, menus, icons, tokens, and i18n.
- Present all background producers through the generic Tool Task strip and
  detail surface. Use transient change notifications plus a cold list read;
  require confirmation for Host-owned detail cleanup and keep it outside the
  model catalog.
- Store Composer Thread mentions as structured UUIDv7 content; resolve current titles
  for menu, transcript, copy, and history presentation without putting titles in the
  canonical URI. Keep missing/current/corrupt/denied targets non-fatal.
- Cover empty, idle, active, failed, interrupted, and input-request states.
- Keep delegation Threads and Session state out of renderer projections. Render
  delegated execution only as generic Bash Items and Tool Tasks.
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
  its reachability through fork, rollback, prune, startup
  reconciliation, and Thread deletion.
- Keep feature stores explicitly owned and keyed by canonical IDs.
- Separate compact Tool Task truth from expandable detail. Preserve terminal
  and delivery facts until Thread deletion; apply per-task, per-Thread, and
  application detail ceilings, delivery-based TTL, reference-aware GC, and
  visible storage-pressure refusal.
- Persist Agent Session policy, ordered root-message control facts, and
  settlement links without adding another transcript or task ledger.
- Serialize Automation claims with pause, delete, Start now, and dispatch; keep
  Memory eligibility based on immutable Turn provenance.
- Test crash recovery and idempotent reconciliation.
- Verify a fresh userData tree contains only declared current artifacts.

## Verification Contract

- For workbench consumers, satisfy
  [Execution Context Publication](agent-model-runtime.md#execution-context-publication):
  keep exact task audit refs separate from semantic model input, append frozen
  contributions at consuming boundaries, and restore scoped state through the
  existing compaction checkpoint. Test actual prepared/post-adapter prefixes,
  tool schemas, affinity, late-delivery fences, and unchanged-state suppression.
  Cache hits are provider observations, not correctness assertions; a real
  capability change cannot be deferred to preserve a prefix.
- Add protocol codec and invalid-state tests.
- Add lifecycle and restart tests for persistent behavior.
- Exercise the complete Skill lifecycle through a provider-driven root Turn
  with real stores, and the real native review through Electron. Cover absent,
  disabled, blocked, and delegated tools; cancellation, caller loss, expiry,
  forged decisions, competing reviews, revoked authority, and cross-runtime
  hash-bound undo. Prove that installation preserves disabled identities and
  never writes configuration or bypasses the invocation ceiling.
- For Tool Tasks, test exact stdin, queue/lease recovery, process-group stop,
  quiescent receipt races, artifact settlement, output limits, retention,
  storage pressure, owner deletion, exactly-once delivery, and source/packaged
  supervisor resolution.
- Prove a Settings change affects only fresh Agent Sessions: existing Sessions
  keep their launcher/model/effort/access snapshot across continuation and restart.
- Prove failed, timed-out, cancelled, and lost delegation outcomes block queued
  input and never trigger another Turn.
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
- Verify bare schema discovery and common schema fragments remain within their
  token budgets, and retired public names or internal Field/View tokens cannot
  return through registry, Skill, recipes, or current specifications.
- Verify complete-resource and dependent-resource CLI goldens assert final
  document state, mutation invocation count, Operation count, visible Operation
  ID/affected/recovery data, and guarded exact revert.
- Run typecheck, Core tests, renderer tests, E2E, docs check, and diff check
  before the PR is ready.

## Settings discovery and source settlement

`settingsDefinitions.ts` is the scalar definition authority shared by validation,
JSON Schema, defaults, search metadata, and direct UI controls. The Host's
preference discovery bridge exposes bounded public source observations and
accepted/effective scalar values, not domain catalogs or credentials. Structural
writes use the caller's observed source digest, reject malformed or stale input,
validate the resulting document, and recheck bytes immediately before atomic
replacement. Reset removes only the named override and retains unrelated JSONC.
A missing source has no observed or accepted digest.

The generated status carries the Host session identity, source observation,
per-owner application state and effective preferences. Appearance, Memory,
updates, Skills, Access, request policy, delegation, and models settle
independently. Failures retain that owner's effective state; accepted request
policy/model/delegation declarations apply at their next admission/read boundary.
A previous Host's status cannot establish current application evidence.

The main frame's actual native-window identity gates each configuration operation.
One Settings renderer has a finite configuration-operation allowlist for its
category panes. Categories and URL parameters do not grant authority. Document
mutations, turn execution, unknown commands, and credential operations are excluded.
Credentials are exclusive to the provider configuration child; About has only its
application/update channels. The main application retains normal command authority;
auxiliary configuration windows do not inherit action-attestation capabilities.
Visited panes stay mounted on navigation, preserving their own drafts, queues,
and subscriptions without eagerly loading unvisited domain catalogs.
Configuration notifications are Host-authored and scoped to `preferences`,
`models`, `agents`, `skills`, or `access`; each consumer subscribes to its owner.

The root configuration editor captures the user/project source digests when an
edit opens. Background catalog refreshes update the manager without replacing
that draft observation. A save against an externally changed source is refused,
leaving the draft visible; reopening the editor establishes a new observation.
Settings and the root manager also refresh source observations when their native
window regains focus, including after editing project configuration externally.
