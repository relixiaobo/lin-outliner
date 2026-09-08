# Unified Session Records

## Goal and reader

OBJ-1: An Agent can recover earlier discussion, investigate a recorded invocation, and inspect its own active conversation through ordinary file discovery and reading. Every returned value has an identifiable original source; missing or transformed content is explicit.

OBJ-2: Retire the model-facing `thread_search` and `thread_read` tools once this path is complete. Preserve Trajectory, Composer Thread references, canonical replay, and historical resource identity.

## Non-goals

No second history ledger, new Work model, separate diagnostic tool, generated fact store, unrelated runtime rewrite, or blanket promise of permanent process logs. No relocation of authoritative stores merely to put them under one directory. File publication is not an OS isolation boundary under Full Access.

## Design

**Shape:** (a) ONE complete feature in one PR. Source resolution, file publication, long-content access, reference integration, lifecycle handling, and retirement land together. The build order below is internal to that PR.

### Decision and constraints

DEC-1: Keep existing original stores and their owners. Introduce one explicit source-resolution contract consumed by Trajectory and the file publisher. Replace the completed-Turn transcript publication with one continuously updated, rebuildable reading tree. Do not create a new canonical `records.jsonl` beside Rollout.

DEC-2: The model uses existing file tools for history. Trajectory retains structured IPC and its own presentation/window logic. Both consumers resolve the same source coordinates and apply the same exact-or-unavailable rules.

The clean-slate goal is a logical conversation record with ordered source references and immutable retained content. Existing Rollout, payload, and resource mechanisms already implement much of it. Replacing those stores wholesale would duplicate lifecycle work without resolving the demonstrated retrieval gaps; simply deleting the tools would leave those gaps exposed.

CON-1: Preserve recorded-notification ordering and durable completion barriers. Inspection publication failure must not fail a Turn. Preserve runtime configuration, capability selection, and resource retention owners.

CON-2: A format change uses the repository's explicit pre-release reset procedure, with no migration or legacy reader. No data reset happens as part of authoring this plan.

### Original ownership

| Information | Original owner | Reading rule |
| --- | --- | --- |
| Accepted messages, canonical Items, Turn completion, rollback/rerun markers | `RolloutStore`; effective state through `ThreadHistoryProjectionStore` | Query projection is replaceable; effective and superseded history must be distinguished |
| Current name, membership, archive state, configuration | `ThreadMetadataStore` | These catalog facts are not all replayable from Rollout; label current metadata separately from historical execution configuration |
| Durable model-call arguments, context, internal text, recorded tool result | `ToolPayloadStore` plus owning Item references | Preserve stored disposition and transformations; do not label replay data as an unmodified provider request |
| Prepared provider input, dispatched request, provider response, retries and call timing | Captured `TurnDiagnosticsCollector` payload | Resolve exact retained coordinates; do not reconstruct an actual request from final chat text |
| Task admission/execution receipt and retained process streams | `ToolTaskStore` and task detail owner | Distinguish task stdout/stderr from the tool result sent to the model; expose detail retention state |
| Historical file identity, source locator and exact revision | `AgentResourceStore` and ContentStore | Distinguish historical bytes from current source; preserve anchor/link ownership |

EVD-1: Current `ThreadTrajectoryProjection` already distinguishes provider-issued arguments from replay storage, and reports missing precise evidence instead of substituting nearby content. Its tests include `reads Tool Input from the exact provider response despite divergent or missing replay storage` and `never substitutes canonical accepted input for missing prepared provider evidence`.

### Requirements for shared source resolution

FR-1: Extract the exact value resolution currently private to `ThreadTrajectoryProjection` into a small main-only module, tentatively `ThreadRecordSources`. It owns no database, event stream, capture process, or model tool. Keep paging, UI record labels and preview formatting in the Trajectory projection.

Each resolved value includes its semantic kind, owning Thread/Turn and applicable Item or diagnostic coordinates, retained content identity, availability, and whether it is persisted or a live observation. Provider calls retain their call index; a tool execution retains its batch/activity coordinate and response-part index. A call ID alone is not sufficient identity.

Separate accepted user content, prepared input, dispatched request, provider-issued tool arguments, admitted/replay arguments, recorded tool result, and process output. These can differ legitimately. Cross-consumer consistency compares the same semantic kind and source coordinate, not vaguely named fields such as `input` or `output`.

Retain the existing exact-or-unavailable selection rule: if diagnostics exist but the requested provider coordinate is invalid, report that field unavailable. Only when diagnostics are absent may an exact replayable Item value be offered, clearly attributed to that different source. An `evidenceOnly` summary never becomes original input.

### File reading structure and flows

FR-2: Replace the existing transcript artifact tree with a single app-owned reading tree. The proposed layout is:

```text
thread-records/
  index.tsv
  {threadId}/
    record.md
    turns/{turnId}.md
    details/{source-and-content-id}.json-or-txt
    resources/{resourceId}/{displayName}
```

All files in this tree are derived. `record.md` is a concise conversation entry with metadata, publication coverage, and ordered links to Turn files. Turn files contain deterministic readable messages/activity, stable source coordinates, availability, and complete-content paths. Detail files preserve retained values; previews explicitly identify truncation or transformation. No model summary is required to build or search the tree.

Use actual files rather than a new virtual filesystem or history-specific dispatch hidden inside `file_read`. Large retained details are materialized by publication and remain independently readable. The public reading tree replaces the old transcript tree; it is not an additional permanently maintained transcript format. A whole-conversation export may be generated on demand from the same reader.

FLOW-1: For earlier work, search `index.tsv` for a named conversation or search the record tree for content; read the matching Turn and follow its exact-content references. Index metadata alone is not a full-text search substitute.

FLOW-2: For an invocation problem, identify the tool record, read its arguments and recorded result, then follow related provider or task references as needed. A returned error is evidence of the observed failure; causal analysis remains the Agent's inference.

FLOW-3: For self-inspection, read the current conversation entry supplied by the runtime, then the required earlier or active Turn. These locations survive compaction. A history read is itself an ordinary recorded tool call; publication never recursively expands referenced history-read results into other histories.

### Publication, lifecycle, and failure recovery

FR-3: Publish on persisted semantic boundaries: accepted input, completed Items, Turn completion, and history replacement. Coalesce publication of an active Turn; do not rewrite the entire conversation on each token delta. Atomically replace the affected Turn file, then its conversation entry and discovery metadata. Completed Turn files normally remain unchanged; source changes, rollback or rebuild invalidate only affected entries.

Discovery membership comes from the eligible catalog, not the existence of an already completed transcript. A first active Turn therefore has an entry, with pending/unavailable publication explicitly represented when necessary. Publish a detail file before advertising its path as available. Serialize writes per Thread and bound background rebuild concurrency; startup repair must not eagerly deserialize every conversation on the main event loop.

Each published entry states its source boundary and publication time. Concurrent reads see a named snapshot, not a claim that all activity is finished. A reader continuing an older file generation must receive an explicit source-changed result instead of silently combining generations. Publishing later detail must not require regenerating every earlier Turn.

BR-1: Keep current record-discovery membership as the proposed default: non-excluded persistent root conversations, including Automation roots, across Profiles as the current file index already does. Apply that rule consistently to the new index, record publication, and Agent-facing Thread-reference resolution. Self is eligible. Delegated Threads do not gain global discovery or tools; their owning session's existing references and isolation policy remain in force. Ephemeral Threads have no durable reading tree. This rule needs ratification with the complete plan because explicit mentions currently use narrower eligibility.

BR-2: Preserve Trajectory's best-effort live diagnostics snapshots. File history promises retained records; an in-memory-only diagnostic is identified as not yet persisted. Do not persist an additional diagnostic ledger just to make the file view appear identical to live UI. If crash-surviving in-flight provider traces become a requirement, change the existing collector's persistence separately and explicitly.

BR-3: Ordinary navigation reflects effective history. Rollback/rerun are visible as historical replacement, with a locator to retained audit records and explicit missing-payload states. Replaced Attempts must not appear as current conversation instructions. Preserve existing payload reclamation; do not silently extend retention through publication copies.

BR-4: Preserve missing-Rollout recovery from surviving projection snapshots. Add durable recovery provenance to the reconstructed Rollout representation: recovery identity/time, projection origin, and loss of original event-order coverage. Consumers propagate that fact. A recovered snapshot remains usable without being advertised as an original uninterrupted event trace.

BR-5: Deletion and exclusion first fence publication, drain or invalidate queued work, and remove the reading tree through the existing lifecycle owner. Startup cleanup derives its queue from actual directories and source membership. Re-inclusion and deleted-cache recovery rebuild from retained originals. An unavailable original cannot be healed from a leftover derived copy and called original again.

### Resources and large-content reading

FR-4: Use `AgentResourceStore.copyForObservation` or its shared primitive to publish independent exact-revision observations under resource identity and display name. Avoid hardlinks or write-through aliases to canonical bytes. These copies create no new canonical resource or current-Thread retention link; their lifetime follows the owning publication and retained resource. Existing source/edit resolution remains available to product consumers. Editing historical bytes through ordinary file operations starts from an explicit copy into the task's chosen output location.

Resource observation publication is asynchronous and failure is explicit. Measure physical disk usage and materialization latency with large resources; copy-on-write support is an optimization, not a guaranteed storage budget. This deliberately accepts some disposable materialization cost to keep file access ordinary and avoid eager injection of resource contents into model context.

FR-5: Extend general text-file reading with a bounded continuation that can resume inside a long line. Preserve existing line-window use. A continuation identifies the source generation, encoding, next position, and observed end; reject incompatible replacement and avoid gaps or duplicated characters. Search content mode provides an actual bounded matching region and a location usable for continued reading, rather than only an omitted-long-line marker. File-only callers must be able to reach retained data without shell byte-range workarounds.

Invalidate content-availability assumptions when model context is compacted or reset. A previous full-file read must not force an `unchanged` response when its contents are no longer present. This must be tested through the actual runtime context lifecycle, not only a fresh test workspace.

### Tool and reference retirement

FR-6: Remove the two model catalog contracts, schemas, runtime handlers, Agent search/read facade, signed history cursors, page-scoped citation-selection facade, and related action descriptors. Keep Composer `searchReferences` / `resolveReferences`, stable Thread markers, and all Trajectory IPC. Adjust their composition without deleting shared functionality merely because it lives in `ThreadHistoryReferenceService` today.

Explicit Thread references project the same record location plus bounded identity/availability metadata. Default/current prompts point to the index and current record, and no active guidance requires a retired tool. Profiles without the required file capability receive an unavailable reading path; a Thread reference alone grants nothing. Automation transcript-location consumers switch to the same conversation entry.

Derive the retirement sweep from `rg` over the active catalog, runtime, context, specs, scripts, and tests. Historical design documents and historically recorded tool-call names are provenance, not runnable compatibility facades. Regenerate catalog assertions rather than deleting unrelated coverage.

### Evidence, acceptance criteria, and verification

AC-1: Given only the documented entry points and a request about earlier work, the Agent retrieves the recorded decision and next action with the originating conversation, without either retired tool.

AC-2: Given an error beyond 100 KB of retained output, the Agent locates the invocation and reads its relevant arguments and error without a private path supplied by the test harness. Prepared/provider/replay values remain distinguishable.

AC-3: Given actual context compaction and an active current Turn, the Agent recovers a prior constraint and completed current-Turn activity. Unfinished activity, publication coverage, and unpersisted diagnostics remain explicit.

AC-4: Given a long JSON string or large text file, search and successive reads reach the matching source bytes within bounded responses. Source replacement, UTF-8 boundaries, cancellation, and context-cache invalidation are covered.

AC-5: Given identical retained source coordinates, Trajectory and file detail agree on the exact value or unavailable outcome, including divergent replay arguments, missing payloads, repeated call IDs, and diagnostic gaps. Preserve Trajectory ordering, keyset pagination, live observation, and bounded-window performance.

AC-6: Given rollback, rerun, fork followed by source deletion, exclusion/re-inclusion, or derived-tree deletion, publication preserves source identity and lifecycle semantics. Recovered Rollout snapshots report recovery provenance; missing original information is never synthesized.

AC-7: Given a changed original external file, the historical reference yields the saved version or explicit unavailability. Reading the conversation creates no new current-Thread resource link; publication copies neither mutate canonical bytes nor extend canonical retention.

EVD-2: Existing deterministic file tests establish the active-publication, missing-locator, and long-line gaps. Existing source and lifecycle tests establish mechanisms to preserve. They do not establish the proposed Agent workflow, publication performance, or post-compaction behavior. Verify those with the completed feature using synthetic histories and recorded tool traces.

Before ready: run typecheck, relevant Core and renderer suites, focused end-to-end history/Trajectory/Thread-reference checks, docs checks, and diff checks. Measure publication write volume for long conversations and resource copy cost. Do not broaden tests after passing without a changed concern.

### File scope and collision result

Expected source scope:

- Source resolution and provenance: `ThreadTrajectoryProjection`, proposed `ThreadRecordSources`, `ThreadCore`, `RolloutStore`, `ThreadHistoryProjectionStore`, and `ThreadCatalogOps`.
- Publication and lifecycle: replace `ThreadTranscriptWriter`, `ThreadTranscriptArtifact`, `ThreadTranscriptIndex`, and the publication-facing renderer; integrate `ThreadService`, `TurnLifecycle`, and `ThreadTranscriptExclusions`. Keep generic dump/export rendering only where it has an actual consumer.
- Resource observations: `ThreadResourceOps`, existing `AgentResourceStore` observation methods, and cleanup integration.
- Generic file capabilities and retirement: `agentLocalTools`, `agentCapabilities`, `ToolRuntime`, `PiTurnExecutor`, `ContextProjector`, `stablePrompt`, model catalog/types/codecs as required, and `ThreadHistoryReference`.
- External consumers: `AutomationDispatcher`, the Agent Host facade, and exact Thread-reference renderer consumers if the resolved-reference contract changes.
- Specifications: Agent Core, model runtime, tool design, integration, and relevant Thread rendering/delegation contracts; focused existing/new tests for each contract.

Build on the Project catalog and lifecycle mechanism merged in PR #651, including its shared Thread metadata database and deletion ownership. Its affected surface includes `ThreadService`, `ThreadMetadataStore`, `ThreadCatalogOps`, model tools/protocol/codec, capability descriptors, Agent Host composition, and Agent specifications. PR #652 shares `agent-integration.md` and potentially Host/preload composition if reference DTOs change; avoid unrelated UI/preload changes.

PR #653 proposes startup fault isolation and targeted conversation recovery. Its recovery-source validation, writer fencing, and resource-preservation rules overlap BR-4/BR-5 and the existing Thread lifecycle owners. Main review should reconcile these contracts together: preserve the only surviving projection, label reconstructed history, and invalidate publication through the same lifecycle owner. Do not introduce an independent recovery coordinator in this feature. The plan files have no direct conflict; refresh implementation claims before coding. Do not edit the main-owned board, changelog, spec index, or infrastructure files without required coordination.

## Open questions

OQ-1: Ratify the proposed file-discovery scope and saved-record boundary with this complete design: current file-index membership, self-inspection, existing retention, and explicit live-only diagnostics. Expanding delegated discovery or retaining every superseded process/provider trace would change the product scope.

The implementation's private type names and exact text-continuation encoding are local choices constrained by this plan. No additional product model or serial design phase is required to choose them.

### Internal build order

1. Settle source ownership, exact resolution, and recovered-history provenance; preserve Trajectory parity.
2. Implement the complete record publisher, resource observations, and lifecycle rebuild/reclamation.
3. Complete generic file continuation/search and actual compaction recovery; wire current/explicit-reference entry points.
4. Retire both model tools and their Agent-only dependencies; reconcile active specs and execute the acceptance tasks.
