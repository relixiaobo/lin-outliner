# Large Local Resources

## Goal

Let an Agent work with local files according to the host account's authority
without rejecting a file merely because its source byte length exceeds a shared
attachment ceiling. Keep provider requests, renderer IPC, event JSON, memory,
and durable storage bounded by separating a resource reference from each
bounded observation of that resource.

The governing abstraction is:

> Local resource reference -> bounded observation

A path-backed attachment remains a live reference to its canonical local file.
A pathless attachment is streamed once into Thread-owned managed storage and
then uses the same reference model. Text reads, image prompt input, previews,
and conversions each produce their own bounded representation rather than
copying the complete source through a general attachment pipeline.

## Non-goals

- Do not make arbitrary source bytes part of Core events, renderer state, JSON
  IPC, provider history, or a model request.
- Do not remove consumer-specific safety budgets for image decoding, PDF
  parsing, Office conversion, provider payloads, previews, or managed storage.
- Do not redesign large-file editing. Existing edit and write preconditions
  remain; the Agent may use bounded reads and `bash` for workflows outside that
  surface.
- Do not snapshot path-backed files or promise that later reads observe their
  attachment-time contents. A local path is intentionally live.
- Do not reuse the Outliner asset store or introduce a second Agent payload
  store.
- Do not broaden a Thread working directory or trusted root merely because a
  user attached one external file.

## Shape

This plan is shape (a): one complete feature in one PR. The internal work order
settles the resource protocol and persistence mechanism before updating its
consumers. The feature is complete only when path-backed and pathless admission,
image prompt replay, bounded file reads, exact external-file authorization,
specification updates, and regression tests ship together.

## Collision Result

- `gh pr list` reported no open PRs at planning time.
- `docs/TASKS.md` reported no in-flight work in this file or protocol area.
- The change touches the shared Agent protocol, Thread persistence, preload
  bridge, renderer attachment flow, local tools, model runtime, and their specs
  and tests. This Draft PR is the claim for those areas.
- The existing Thread-owned content-addressed payload store is the storage
  owner. The implementation extends it instead of creating a parallel managed
  attachment store.
- This plan intentionally does not edit main-owned `docs/TASKS.md` or
  `CHANGELOG.md`.

## Design

### Resource Contract

Replace the attachment union's byte-bearing inline variant with reference-only
sources:

- `localFile`: canonical path plus stable display metadata;
- `threadPayload`: immutable content-addressed payload identity plus MIME type,
  byte length, and display metadata.

The canonical attachment ID identifies the admitted resource. It is stable in
the recorded user Item and is the authorization key for operations that need to
cross the normal Thread path boundary. No attachment source contains base64 or
an unbounded byte array.

Path-backed admission resolves symlinks, records the canonical path, and does
not copy or reject regular files based on source length. Directory references
remain supported only when they resolve inside the Thread working directory;
they are not copied and record a zero byte size. Later access revalidates the
referenced path and reports native missing or changed behavior.

Pathless admission streams chunks across the preload boundary into a staged
Thread payload writer. The writer enforces a managed-input storage budget,
computes content identity incrementally, atomically publishes the completed
payload, and removes partial data on cancellation, validation failure, or
shutdown. Admission records the attachment only after finalization succeeds.

### Thread-owned Payloads

Extend `ToolPayloadStore` into the single Thread resource-payload owner while
preserving its content-addressed layout and fork/delete semantics. Text tool
outputs and managed inputs share lifecycle mechanics but retain typed APIs so a
caller cannot confuse an output projection with an attachment resource.

Payload references always carry digest, MIME type, and byte length. Reads verify
identity and expected length. Thread deletion removes owned payloads; forks
materialize any inherited managed resource under the fork's directory with a
distinct inode, using copy-on-write where available and a real copy otherwise.
External local paths remain external references and are never deleted by Thread
cleanup.

The content-addressed file is a private immutable storage object, never a model-
visible or externally opened working file. A managed non-image attachment is
copied into a Turn-scoped scratch observation before its path enters model
context; the observation is removed when execution ends. Preview, Open, and
Reveal share one stable detached scratch copy per attachment identity, reclaimed
by the existing scratch TTL. Mutating either kind of copy cannot invalidate
canonical history. Cleanup and rollback compare the physical resource key
(`digest + safe filename`);
metadata such as MIME type does not create a second physical owner.

### Bounded Image Observation

Image attachments are normalized in main, never renderer. The renderer sends a
local-file reference or streams a pathless source; it does not call
`FileReader.readAsDataURL` and does not construct base64 protocol content.

Before model input, main serializes all native image observations across Threads
and tool calls, decodes within an image-specific source-byte budget, applies
orientation, downscales to the configured maximum dimensions, and writes the
bounded encoded prompt snapshot to Thread-owned payload storage. The persisted
user Item references both the original resource and this immutable prompt
snapshot. Initial execution, steering replay, history reconstruction, and Thread
forks therefore observe the same bounded image bytes even if an external source
later changes.

Unsupported, corrupt, or over-budget decoded images fail with an attachment-
specific error. Provider adapters read the bounded snapshot and perform any
provider-native encoding only at the request boundary; base64 never becomes a
canonical protocol or renderer representation.

### Bounded Text Observation

`file_read` limits the observation, not the source. It opens the file as a
stream, incrementally scans only far enough to produce the requested line or
byte window plus truncation metadata, then closes immediately. It must not call
an entire-file buffering API before enforcing the output budget.

The result preserves the current bounded model-visible projection and durable
output payload behavior. Binary detection uses a bounded prefix. Requested
offsets outside the file return a stable empty/end-of-file result; abort and
filesystem errors close the handle and remain native tool failures.

### Exact External-file Authorization

An admitted external `localFile` does not become a trusted root. Preview, Open,
Reveal, and resource reads that originate from the attachment UI resolve the
canonical attachment ID through the owning Thread Item and authorize only the
recorded canonical file. A managed `threadPayload` resolves the same identity but
serves a disposable scratch copy instead of exposing its canonical store path.
The operation rejects mismatched IDs, non-file targets, and path substitution.

Agent file tools continue to follow the Full Access capability contract. Exact
attachment authorization exists for renderer-to-main host operations; it is not
a second Agent filesystem sandbox.

### Consumer-specific Budgets

Remove the shared source-file ceiling and keep named limits at the point where a
consumer allocates or transforms data:

- managed pathless payload byte budget and Thread storage quota;
- image source-byte, output-byte, dimension, and provider-request budgets;
- PDF parser page/byte/time budgets;
- Office converter byte/time/output budgets;
- preview range and media-stream behavior;
- model-visible text/output limits and durable payload-read ranges.

Limit errors name the consumer and the violated budget. A parser refusing a
resource must not be reported as a generic attachment-size rejection.

### Failure And Recovery

Admission is transactional: no user Item is recorded until every pathless
upload and required image snapshot is finalized. Failure removes owned staging
files and any newly created, still-unreferenced prompt snapshots while leaving
path-backed and pre-existing content-addressed resources untouched. Startup
cleanup reconciles crash leftovers and removes stale staging entries. Upload
chunking and file scanning observe cancellation and close their active reader or
stream. Electron's native image transform exposes no cooperative cancellation
primitive, so once image normalization starts it runs to completion inside its
independent source-byte, dimension, and encoded-output budgets; only a completed
snapshot may be published.

Persisted attachment references are replayable without renderer state. Missing
external files produce explicit unavailable content while managed payload
digest or length mismatch is treated as storage corruption and never silently
replaced with current bytes.

## Open Questions

None. The product direction and architectural boundaries were ratified before
implementation. Reversible choices such as private helper names, chunk size,
and exact error copy are implementation details and will be recorded in the PR.

## Verification

- Protocol codec tests reject byte-bearing inline attachments and round-trip
  local-file and Thread-payload references.
- Admission tests cover very large sparse local files without copying, streamed
  pathless payload finalization, cancellation cleanup, quota failures, replay,
  independent-inode fork, metadata-alias cleanup, and delete lifecycle.
- Image tests prove renderer/base64 removal, bounded normalization, deterministic
  replay after source mutation, corrupt input failure, and provider-boundary
  conversion.
- Local-tool tests prove `file_read` does not buffer the complete source and
  stops after the requested bounded window for large files.
- Authorization tests prove one attachment ID grants only its exact canonical
  file, managed observations cannot mutate canonical history, and neither source
  can widen a trusted root or substitute a symlink target.
- Run `bun run typecheck`, `bun run test:core`, `bun run test:renderer`, relevant
  Agent E2E tests, `bun run docs:check`, and `git diff --check`.
