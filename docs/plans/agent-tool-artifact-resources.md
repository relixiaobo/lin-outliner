# Agent Tool Artifact Resources

Shape: **(a) ONE complete feature in one PR.** The protocol ownership field,
runtime artifact sink, first-party producer wiring, lifecycle integration, tests,
and current specifications land together. Internal build order establishes the
resource contract before converting individual tools.

## Goal

Make non-image files produced by Agent tools durable Thread resources instead of
unregistered scratch files.

The minimum acceptable outcome is that completed tool-produced files from
`web_fetch`, shell output capture, and managed-Skill output directories have:

- a canonical `ThreadResourceReference` owned by the tool Item that produced
  them;
- a rematerializable readable path that `file_read` can inspect;
- lifecycle participation in Thread deletion, fork/inherited-context copying,
  rollback reconciliation, and unreferenced-resource pruning; and
- model-visible wording that treats paths as access handles, not durable
  identity.

This closes the tool-agnostic residue left after the browser/computer-control
plans were superseded: downloads, PDFs, screenshots, and other tool artifacts
belong to the Thread resource system, not to flat workspace scratch directories.

## Non-goals

- Do not change the generated-image artifact model. Image originals,
  observations, geometry, and retention keep the `ThreadImageArtifactReference`
  contract shipped by `generated-image-resources`.
- Do not add an `artifact_create` tool or a separate artifact store.
- Do not expose canonical payload-store paths to the renderer or the model.
- Do not make `file_read` accept a resource reference directly in this PR; it
  continues to read the rematerialized path returned by the producing tool.
- Do not persist arbitrary workspace files just because a command created them.
  Only tool-declared outputs and bounded managed-Skill output-root files are
  admitted.
- Do not make a running background-process log immutable. A running task may
  still have a live scratch path; only a completed or stopped output can be
  content-addressed as a Thread resource.
- Do not ship `computer-pilot-managed-skill` itself. This plan provides the
  artifact mechanism that feature can rely on.

## Design

### Canonical ownership

Reuse `ThreadResourceReference` as the identity for non-image tool artifacts.
There is no new artifact identity type for ordinary files: content hash, MIME
type, byte length, and safe file name are enough for resource storage and
filesystem materialization.

Add `resourceRefs` to the shared tool Item base so every tool Item can own zero
or more non-image resources. Existing tool Items decode old history with
`resourceRefs: []`. New completed Items record the resource references produced
by that execution. `itemResourceReferences` then includes those tool-owned
resources in the same dependency graph already used for context payloads, image
artifacts, fork copying, rollback reconciliation, and pruning.

`outputRef` remains the complete textual/JSON result payload. It is not reused
for binary or file artifacts. A tool Item may have both: `outputRef` for the
retained result text and `resourceRefs` for produced files.

### Runtime artifact sink

Introduce an internal `ToolArtifactSink` passed from `ToolRuntime.createTools`
into first-party tool factories:

```ts
interface ToolArtifactSink {
  persistBytes(input: {
    bytes: Uint8Array;
    mimeType: string;
    fileName: string;
  }): Promise<ToolArtifactResource>;

  persistFile(input: {
    path: string;
    mimeType: string;
    fileName: string;
  }): Promise<ToolArtifactResource>;
}

interface ToolArtifactResource {
  ref: ThreadResourceReference;
  readablePath: string | null;
}
```

The production sink is built from the active `TurnExecutionContext`:

1. write bytes through `persistOutputResource`;
2. ask the Thread resource materializer for a readable observation path;
3. return the reference plus the path hint to the tool; and
4. degrade a materialization failure to a missing `readablePath`, not a failed
   Turn, when canonical bytes were successfully stored.

The sink never hands out canonical payload-store paths. The readable path is a
scratch materialization and can expire under the existing scratch TTL. The
resource reference is the durable identity.

Direct test helpers that construct tools without a runtime must supply an
explicit fake or scratch-backed sink. Production tool creation must not silently
fall back to unmanaged `agent-web-fetch` or `agent-tool-outputs` directories for
completed artifacts.

### Tool result shape

Extend `AgentToolResult` with a non-model-visible resource manifest:

```ts
interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  terminate?: boolean;
  resourceRefs?: readonly ThreadResourceReference[];
}
```

First-party tools append every successfully persisted resource reference to this
manifest. `PiTurnExecutor` copies the manifest onto the completed tool Item's
`resourceRefs`.

The model-visible JSON keeps actionable fields close to the existing tool
contracts:

- `web_fetch.data.binaryFile` includes `filePath`, `resourceRef`, `mimeType`,
  `byteLength`, and `sha256`.
- `bash` and `task_stop` expose a `persistedOutput` object with `filePath`,
  `resourceRef`, and `byteLength` when a final saved log exists.
- managed-Skill shell output uses the same `persistedOutput` vocabulary when a
  Skill command's capped output is saved.

When `readablePath` is unavailable but the resource was stored, the tool returns
the `resourceRef`, omits `filePath`, and adds a warning that the artifact is
stored but not currently materialized for `file_read`.

### Producers converted in this PR

#### `web_fetch` binary responses

`web_fetch` no longer writes successful binary responses to the flat
`agent-web-fetch` scratch directory in production. The fetched bytes are already
bounded and in memory, so the tool writes them directly through
`ToolArtifactSink.persistBytes`.

The returned `binaryFile.filePath` is the materialized Thread resource path. The
returned `binaryFile.resourceRef` is the durable identity. The visible guidance
continues to say that `file_read` should inspect supported binary files, but it
describes the path as a readable handle.

#### Shell saved output

Foreground shell output that exceeds the inline cap is finalized into one text
log, then registered with `ToolArtifactSink.persistFile`. The old flat saved log
path is not exposed as the durable artifact path after registration succeeds.

Background shell startup remains a live-process contract. While the command is
running, the returned output path is explicitly temporary and is not recorded as
a resource. When `task_stop` returns final output for a stopped or already
completed task, it registers the final log and returns the same
`persistedOutput` shape as foreground shell.

#### Managed-Skill output roots

Managed Skills already receive per-Turn output directories through their host
environment. The implementation adds a bounded collector around each isolated
managed-Skill invocation:

1. snapshot the output root before invocation;
2. after the invocation finishes, enumerate new or changed regular files under
   that root;
3. reject symlinks, directories, hidden control files, oversized files, and
   excess file counts;
4. persist accepted files through the sink; and
5. report a resource manifest plus bounded warnings for skipped files.

This is intentionally an output-root collector, not a workspace sweep. It gives
future computer-control Skills a durable screenshot/download story without
letting arbitrary command side effects become Thread resources.

### Lifecycle and projection

`scanThreadItemResourceUsage` treats tool Item `resourceRefs` as generic
resources. Image artifact resources keep their existing special handling; a
tool-owned non-image resource is protected from image-retention reclamation even
when its MIME type is `image/*`.

Forking and inherited context copy the declared resources under the target
Thread exactly as other generic managed resources are copied today. Missing
bytes degrade through the existing payload-unavailable path instead of aborting
the surrounding Turn.

Context projection may mention tool-owned resources through result text or
bounded tool-output projections, but it does not read full binary bytes into the
provider context. The provider sees paths and metadata; `file_read` remains the
explicit inspection step.

Renderer inspection uses the same item-output and resource-read/export authority
as other Thread resources. It never receives canonical payload paths.

### Failure behavior

Resource persistence is fail-closed at the write boundary: invalid MIME, unsafe
file names, quota exhaustion, digest mismatch, symlink substitution, and
filesystem-capacity errors prevent that artifact from being admitted.

Artifact failure does not automatically fail the whole tool when the tool's
primary operation succeeded. The tool result reports partial success with
warnings, omits the failed artifact from `resourceRefs`, and leaves enough
metadata for the model to retry or choose another approach. This follows A12:
corrupt bytes must not enter the store, but artifact admission failure should not
kill an otherwise useful Turn.

## Files and tests

Expected implementation files:

- `src/core/agent/protocol.ts` and the agent codec for tool Item
  `resourceRefs`;
- `src/main/agent/runtime/kernel/types.ts`, `ToolRuntime`, and
  `PiTurnExecutor` for the sink and result manifest;
- `src/main/agent/thread/ThreadResourceOps`,
  `src/main/agent/persistence/ToolPayloadStore`, and
  `src/main/agent/context/contextDependencies` for lifecycle coverage;
- `src/main/agent/capabilities/agentTools`, `agentWebTools`,
  `agentLocalTools`, and `agentSkillShell` for producer conversion;
- `tests/core/agentWebTools.test.ts`,
  `tests/core/agentLocalTools.test.ts`,
  `tests/core/agentThreadService.test.ts`,
  `tests/core/agentContextComposer.test.ts`, and focused codec/resource-store
  tests; and
- `docs/spec/agent-core.md`, `docs/spec/agent-model-runtime.md`, and
  `docs/spec/agent-tool-design.md`.

Required test coverage:

- `web_fetch` binary responses return a Thread resource reference and a
  `file_read`-readable materialized path without writing to unmanaged
  `agent-web-fetch` storage.
- foreground shell capped output and `task_stop` final output return
  `persistedOutput.resourceRef` plus a readable path.
- managed-Skill output-root collection admits only bounded safe regular files
  and reports skipped files without failing the invocation.
- completed tool Item `resourceRefs` survive codec round trip, restart, fork,
  inherited context, and renderer item projection.
- resource pruning keeps tool-owned resources and removes unreferenced produced
  files.
- quota, unsafe filename, symlink, missing materialization, and digest mismatch
  cases degrade at the tool-result boundary without admitting corrupt resources.

Run `bun run typecheck`, `bun run test:core`, relevant renderer tests if the
Trajectory/resource inspector surface changes, and `bun run docs:check` before
marking the implementation PR ready.

## Collision result

Open PR self-check found Draft PR `#575` (`codex/agent-trajectory-workspace-impl`)
claiming agent protocol/codec trajectory contracts, Thread resource reads and
exports, runtime lifecycle contribution, renderer Trajectory workspace, and
agent specs. This plan's implementation overlaps the same protocol/runtime/spec
area through `ThreadItem` shape, `ThreadResourceOps`, `ToolRuntime`,
`PiTurnExecutor`, and agent specs.

Recommended sequencing: review this design now if useful, but do not start the
implementation branch until `#575` merges or is explicitly re-scoped. If the PM
wants both in flight, land a deliberately coordinated interface decision first;
otherwise this implementation should rebase on `#575` and adjust to the final
Trajectory resource inspection shape.

Board self-check: `agent-tool-artifact-resources` is listed as a P3 draft with
no plan file; `docs/TASKS.md` and `CHANGELOG.md` are main-owned and are not part
of this dev-agent plan change.

## Open questions

None blocking. The plan intentionally keeps `file_read` path-based for this PR
and treats direct `file_read({ resourceRef })` support as a separate product
decision if the path handle later proves insufficient.
