# Unified Session Records

## Goal and reader

OBJ-1: An Agent can recover earlier discussion, investigate a recorded invocation, and inspect its own active conversation through ordinary file discovery and reading. Every returned value has an identifiable original source; missing or transformed content is explicit.

OBJ-2: Retire the model-facing `thread_search` and `thread_read` tools once this path is complete. Preserve Trajectory, Composer Thread references, canonical replay, and historical resource identity.

## Non-goals

No second history ledger, new Work model, separate diagnostic tool, generated fact store, unrelated runtime rewrite, or blanket promise of permanent process logs. No relocation of authoritative stores merely to put them under one directory. File publication is not an OS isolation boundary under Full Access.

## Design

**Shape:** (a) ONE complete feature in one PR. Source resolution, file publication, long-content access, reference integration, lifecycle handling, and retirement land together. The build order below is internal to that PR. This file is its complete execution contract; status and selected merge order live in `docs/TASKS.md`.

### Decision and constraints

DEC-1: Keep existing original stores and their owners. Introduce one explicit source-resolution contract consumed by Trajectory and the file publisher. Replace the completed-Turn transcript publication with one continuously updated, rebuildable reading tree. Do not create a new canonical `records.jsonl` beside Rollout.

DEC-2: The model uses existing file tools for history. Trajectory retains structured IPC and its own presentation/window logic. Both consumers resolve the same source coordinates and apply the same exact-or-unavailable rules.

The clean-slate goal is a logical conversation record with ordered source references and immutable retained content. Existing Rollout, payload, and resource mechanisms already implement much of it. Replacing those stores wholesale would duplicate lifecycle work without resolving the demonstrated retrieval gaps; simply deleting the tools would leave those gaps exposed.

CON-1: Preserve recorded-notification ordering and durable completion barriers. Inspection publication failure must not fail a Turn. Preserve runtime configuration, capability selection, and resource retention owners.

CON-2: A format change uses the repository's explicit pre-release reset procedure, with no migration or legacy reader. No data reset happens as part of authoring this plan.

CON-3: Published record files describe retained history. Command outcomes and process liveness remain governed by Tool Tasks and execution context; current verification and Git decisions require native-state inspection, without a private source-certification or commit-admission engine. Preserve hidden delegated-session references and isolation; readable history does not grant execution authority or broaden delegated discovery.

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

BR-1: Use the ratified record-discovery membership: non-excluded persistent root conversations, including Automation roots, across Profiles as the current file index already does. Apply that rule consistently to the new index, record publication, and Agent-facing Thread-reference resolution. Self is eligible. Delegated Threads do not gain global discovery or tools; their owning session's existing references and isolation policy remain in force. Ephemeral Threads have no durable reading tree. Explicit references use this same eligibility rather than their former narrower scope.

BR-2: Preserve Trajectory's best-effort live diagnostics snapshots. File history promises retained records; an in-memory-only diagnostic is identified as not yet persisted. Do not persist an additional diagnostic ledger just to make the file view appear identical to live UI. If crash-surviving in-flight provider traces become a requirement, change the existing collector's persistence separately and explicitly.

BR-3: Ordinary navigation reflects effective history. Rollback/rerun are visible as historical replacement, with a locator to retained audit records and explicit missing-payload states. Replaced Attempts must not appear as current conversation instructions. Preserve existing payload reclamation; do not silently extend retention through publication copies.

BR-4: Preserve missing-Rollout recovery from surviving projection snapshots. Add durable recovery provenance to the reconstructed Rollout representation: recovery identity/time, projection origin, and loss of original event-order coverage. Consumers propagate that fact. A recovered snapshot remains usable without being advertised as an original uninterrupted event trace.

BR-5: Deletion and exclusion first fence publication, drain or invalidate queued work, and remove the reading tree through the existing lifecycle owner. Startup cleanup derives its queue from actual directories and source membership. Re-inclusion and deleted-cache recovery rebuild from retained originals. An unavailable original cannot be healed from a leftover derived copy and called original again.

### Resources and large-content reading

FR-4: Use `AgentResourceStore.copyForObservation` or its shared primitive to publish independent exact-revision file copies under resource identity and display name. Avoid hardlinks or write-through aliases to canonical bytes. Publication copies create no canonical resource; their lifetime follows the owning publication and retained resource. Publishing records, browsing metadata, and resolving historical references must not attach the historical original to the reading Thread or extend its retention. Existing source/edit resolution remains available to product consumers. Editing historical bytes starts from an explicit copy into the task's chosen output location.

An actual file read remains an ordinary recorded tool invocation. If it returns an image or rendered PDF page to the model, persist that observation through the existing `PiTurnExecutor` and `TurnLifecycle` tool-output contract, under the reading Thread. Preserve existing normalization, limits, omission reporting, and replay behavior. The saved observation represents what this invocation returned; it does not adopt the source resource or promise retention of the whole PDF or source conversation. Source deletion follows the original owner's rules; the new observation follows its own Item and reading Thread. No history-specific exception to ordinary file reading or new observation store is needed.

Resource file publication is asynchronous and failure is explicit. Measure physical disk usage and materialization latency with large resources; copy-on-write support is an optimization, not a guaranteed storage budget. This deliberately accepts some disposable materialization cost to keep file access ordinary and avoid eager injection of resource contents into model context.

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

AC-7: Given a changed original external file, the historical reference yields the saved version or explicit unavailability. Publishing records, browsing metadata, and resolving historical references create no reading-Thread link to the historical original. Publication copies neither mutate canonical bytes nor extend canonical retention.

AC-8: Given an image or PDF in source Thread A, Thread B reads the published image or selected PDF page through ordinary file tools and records the returned model observation under the existing tool-output contract. After deleting A and restarting, B replays its retained observation without A's source or publication files. Assert that the original resource follows A's lifecycle, B has not adopted the original image/PDF, and the new observation follows B's Item retention and cleanup. Preserve explicit omission/unavailability when normal tool-output limits prevent retention; do not claim the returned rendition is the original file.

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

Build on the Project catalog and lifecycle mechanism merged in PR #651, including its shared Thread metadata database and deletion ownership, and the Host/configuration contracts merged in PR #652. Their affected surface includes `ThreadService`, `ThreadMetadataStore`, `ThreadCatalogOps`, model tools/protocol/codec, capability descriptors, Agent Host composition, and Agent specifications. Avoid unrelated UI/preload changes.

### Cross-plan ownership and order

Consume [startup fault isolation](../spec/architecture.md#desktop-host-lifecycle) first under the selected A7 order. It owns recoverable startup, capability availability, issue/action identity, and owner retry/producer fencing. Publication failure must use those owner boundaries without disabling healthy document work or creating another startup coordinator.

This feature owns shared exact-source resolution (FR-1), durable recovered-history provenance (BR-4), and record publication invalidation/cleanup (BR-5), integrated with existing Thread lifecycle owners. [Targeted conversation recovery](targeted-thread-recovery.md) follows and consumes these final mechanisms for verified rebuild/removal, preserving the only surviving projection and unrelated resources. It adds no independent source interpretation or publication cleanup coordinator. Its startup dependency is a capability prerequisite; the selected order around this record refactor follows A7.

[Profile files and direct learning](memory-agent-profile.md#implementation-ownership-and-complete-delivery-units)
consumes these final source coordinates and availability/provenance contracts
before targeted recovery. The profile owner determines learning eligibility and
invalidation; this resolver reports original evidence and never grants source
access or interprets a retained preference as execution authority. Node retention
quality has its own complete delivery boundary and actual Memory/source collision
check. Optional profile-plan additions do not delay this record refactor.

Consume the final workbench Tool Task, context, artifact and isolation contracts.
Git and verification Skills use native commands and generic results, not private
review/check evidence producers. Resolve retained history through generic source
coordinates and retention owners; cover output expiry, restart and process
reconciliation without inventing a result reader or execution authority. Settings
G owns final domain destinations and Host/preload projections; reuse those
contracts for reference consumers. CON-3 governs their relationship to history.

The board records live claims and merge eligibility. At claim time recheck the actual ThreadService, Tool Task, context/runtime, Host/preload, and renderer overlaps; do not copy a stale open-PR list into this plan. Specs describe current behavior until implementation folds the final contracts into them.

### Execution handoff and acceptance mapping

| Internal build stage | Required result inside this PR | Evidence |
| --- | --- | --- |
| Exact sources and recovery provenance | One source resolver serves Trajectory and the file publisher, retaining semantic/source-coordinate distinctions and recovered-history origin. | FR-1, BR-2, BR-4; AC-5, AC-6 |
| Publication and ownership | Active/completed records, full-content paths and independent resource copies publish with bounded work, generation checks, deletion fencing and retained-source cleanup. | FR-2, FR-3, FR-4, BR-3, BR-5; AC-2, AC-3, AC-6 through AC-8 |
| Ordinary-file retrieval | Long-line search/continuation and real compaction recovery work through ordinary file tools; current/explicit Thread entry points lead to the same reading tree. | FR-5, FR-6; AC-1 through AC-4, AC-8 |
| Complete cutover | Retire both model tools only with all replacement flows usable; preserve Composer, Trajectory, Automations, hidden-session references and current execution authorities. | FR-6, CON-1, CON-3; AC-1 through AC-8 |

These stages are build order, not separate PRs. The implementation must exercise a scope matrix covering same/cross Profile, user/Automation root, self, excluded, ephemeral and delegated Threads for index publication and explicit-reference resolution. A capability-disabled caller receives an unavailable read path in every otherwise eligible case.

## Open questions

No unresolved product questions. BR-1 defines the ratified discovery scope for both publication and explicit references. Existing retention and explicit live-only diagnostics remain the saved-record boundary; expanding delegated discovery or retaining every superseded process/provider trace requires a separate scope change.

The implementation's private type names and exact text-continuation encoding are local choices constrained by this plan. No additional product model or serial design phase is required to choose them.

### Internal build order

1. Settle source ownership, exact resolution, and recovered-history provenance; preserve Trajectory parity.
2. Implement the complete record publisher, resource observations, and lifecycle rebuild/reclamation.
3. Complete generic file continuation/search and actual compaction recovery; wire current/explicit-reference entry points.
4. Retire both model tools and their Agent-only dependencies; reconcile active specs and execute the acceptance tasks.
