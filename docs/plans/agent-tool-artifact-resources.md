# Agent Tool Artifact Resources

Shape: **(a) ONE complete feature in one PR.** The protocol ownership field,
runtime artifact sink, first-party producer wiring, lifecycle integration, tests,
and current specifications land together. Internal build order establishes the
resource contract before converting individual tools.

## Goal

Make non-image files produced by Agent tools durable Thread resources instead of
unregistered scratch files.

The minimum acceptable outcome is that completed, resource-admissible
tool-produced files from `web_fetch`, shell output capture, and managed-Skill
output directories have:

- a canonical `ThreadResourceReference` owned by the tool Item that produced
  them;
- a rematerializable readable path for the current execution that `file_read`
  can inspect;
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

`outputRef` remains the complete stable textual/JSON result payload. It is not
reused for binary or file artifacts, and it does not retain an execution-scoped
readable path. A tool Item may have both: `outputRef` for the retained result
text and `resourceRefs` for produced files.

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
Turn-scoped scratch materialization that is removed when the execution's
resource observation is disposed; it must not be treated as replayable history.
The resource reference is the durable identity.

Direct test helpers that construct tools without a runtime must supply an
explicit fake or scratch-backed sink. Production tool creation must not silently
fall back to unmanaged `agent-web-fetch` or `agent-tool-outputs` directories for
completed artifacts.

The sink enforces the same single-resource byte ceiling as the Thread resource
store before it reads a file into memory. A caller that hands the sink an
oversized file receives a typed artifact-admission failure and must report that
failure in its own envelope rather than exposing a fake durable reference.

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

The live model-visible JSON keeps actionable fields close to the existing tool
contracts:

- `web_fetch.data.binaryFile` includes `filePath`, `resourceRef`, `mimeType`,
  `byteLength`, and `sha256`.
- `bash` and `task_stop` expose a `persistedOutput` object with `filePath`,
  `resourceRef`, and `byteLength` when a final saved log exists.
- managed-Skill shell output uses the same `persistedOutput` vocabulary when a
  Skill command's capped output is saved.

Persisted slim details and model-facing result text retain each `resourceRef`
and its stable metadata, but not `filePath`. Historical tool-result projection
resolves every tool Item `resourceRefs` entry through the current Thread's
`resolveResourceObservationPath` authority and appends a deterministic bounded
artifact block with the current readable path. The projection does not rewrite
the canonical Item or `outputRef`, and it does not read artifact bytes into the
provider context. A fork therefore resolves against the copied target-Thread
resource rather than replaying the source Thread's path.

When `readablePath` is unavailable but the resource was stored, the tool returns
the `resourceRef`, omits `filePath`, and adds a warning that the artifact is
stored but not currently materialized for `file_read`. Historical projection
uses the same unavailable warning when rematerialization fails.

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

Shell capture must become resource-admissible before this conversion lands. The
implementation chooses a dedicated shell saved-output artifact cap that is no
larger than `MAX_MANAGED_ATTACHMENT_BYTES` and enforces it at the capture
boundary, not only at the later resource write. When a foreground command crosses
that cap, the command returns a bounded `output_limit_exceeded` error or partial
envelope with a warning that the full log was not admitted as a durable Thread
resource. It may include a capped persisted log resource if the captured bytes
fit the artifact cap, but it must not return a successful `persistedOutput` with
neither `resourceRef` nor an explicit oversized warning.

Background shell startup remains a live-process contract. While the command is
running, the returned output path is explicitly temporary and is not recorded as
a resource. When `task_stop` returns final output for a stopped or already
completed task, it registers the final log and returns the same
`persistedOutput` shape as foreground shell. The same artifact cap and
oversized-output result rule apply at stop/finalization time.

#### Managed-Skill output roots

Managed Skills already receive per-Turn output directories through their host
environment, but environment variables are not ownership. Add a typed output-root
seam to the managed shell environment contribution:

```ts
interface AgentShellOutputRoot {
  id: string;
  skillId: string;
  path: string;
  label: string;
}

interface AgentShellProcessEnvironment {
  env?: NodeJS.ProcessEnv;
  leadingToolPathSegments?: readonly string[];
  declaredOutputRoots?: readonly AgentShellOutputRoot[];
}
```

`ManagedSkillShellEnvironmentRegistry` merges only roots declared by active
contributors, validates each root as an app-owned physical directory under that
contributor's Turn-scoped scratch area, and passes the typed declarations to the
managed-Skill invocation collector. Existing env vars such as Browser Pilot's
output directory may continue to point the external CLI at the same directory,
but the env var is not parsed back as authority.

The implementation adds a bounded collector around each isolated managed-Skill
invocation:

1. snapshot each typed declared output root before invocation;
2. after the invocation finishes, enumerate new or changed regular files under
   those declared roots only;
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

Context projection never treats the path captured by the producing execution as
history. It projects stable result text, rematerializes each declared tool-owned
resource for the current execution, and adds the current path plus metadata as a
bounded artifact observation. The provider sees paths and metadata but not full
binary bytes; `file_read` remains the explicit inspection step. This replay-time
rematerialization is required after the producing Turn ends, on restart, and in
a fork.

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
- `src/main/agent/context/ContextProjector` for replay-time artifact
  rematerialization;
- `src/main/agent/capabilities/agentTools`, `agentWebTools`,
  `agentLocalTools`, and `agentSkillShell` for producer conversion;
- `src/main/managedSkillShellEnvironment.ts` and `src/main/browserPilotHost.ts`
  for typed declared output roots;
- `tests/core/agentWebTools.test.ts`,
  `tests/core/agentLocalTools.test.ts`,
  `tests/core/managedSkillShellEnvironment.test.ts`,
  `tests/core/browserPilotHost.test.ts`, `tests/core/agentThreadService.test.ts`,
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
- foreground shell and `task_stop` oversized logs follow the explicit
  `output_limit_exceeded` / partial-warning path and never claim durable output
  without a `resourceRef`.
- managed shell contributors expose output roots through typed
  `declaredOutputRoots`; the collector does not discover roots by parsing env
  vars or scanning scratch.
- managed-Skill output-root collection admits only bounded safe regular files
  and reports skipped files without failing the invocation.
- completed tool Item `resourceRefs` survive codec round trip, restart, fork,
  inherited context, and renderer item projection.
- persisted tool output omits the producing Turn's live path; after that Turn's
  resource observation is disposed, next-Turn, restart, and fork projection each
  rematerialize a readable path in the current Thread and `file_read` can inspect
  it.
- failed historical rematerialization emits the stable resource identity plus a
  bounded unavailable warning without failing projection or the Turn.
- resource pruning keeps tool-owned resources and removes unreferenced produced
  files.
- quota, unsafe filename, symlink, missing materialization, and digest mismatch
  cases degrade at the tool-result boundary without admitting corrupt resources.

Run `bun run typecheck`, `bun run test:core`, relevant renderer tests if the
Trajectory/resource inspector surface changes, and `bun run docs:check` before
marking the implementation PR ready.

## Trajectory integration boundary

The implementation extends the shipped trajectory protocol, Thread resource
reads, runtime lifecycle, and renderer resource-inspection shape. It must use
the canonical `ThreadTrajectoryRecordDetail` and audited resource readers rather
than introducing a parallel artifact DTO or restoring disposed Turn paths.
Changes to `ThreadItem`, `ThreadResourceOps`, `ToolRuntime`, `PiTurnExecutor`, or
the shared protocol remain one coordinated interface decision.

## Open questions

None blocking. The plan intentionally keeps `file_read` path-based for this PR
and treats direct `file_read({ resourceRef })` support as a separate product
decision if the path handle later proves insufficient.
