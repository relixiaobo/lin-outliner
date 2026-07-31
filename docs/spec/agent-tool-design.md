# Agent Tool Design

Agent tools use one provider-neutral registry. A canonical identity is either
`name` or `namespace.name`; namespace and name components use lowercase letters,
digits, and underscores.

## Registry

Each `ModelToolContract` declares:

- canonical identity
- model-facing description
- `rootThread` or `anyThread` scope
- schema owner
- concrete input and optional output schema
- action kinds used for capability evaluation and audit

Core owns control and collaboration schemas. Retained capabilities contribute
their established schemas. Configuration contributes the `skill` schema.
Extensions must provide complete schemas and cannot use the reserved
`collaboration` namespace.

Registry assembly fails when a required schema is missing, a canonical identity
duplicates another, an extension uses an unsupported action kind, or provider
encoding would collide. Flat provider names use `namespace__name`; tool-name
components cannot contain the separator, making the mapping reversible.

Domain-owned tool handlers are contributed by their owning modules; `runtime/`
only distributes those contributions through the same assembly seam used by
extensions. `SubagentCollaboration` owns the collaboration handlers, and future
command families such as browser control land in their domain module and
contribute tools through this seam rather than adding domain logic to runtime.

## Canonical Catalog

### Outline

- `node_search`: query visible Nodes with bounded structured filters
- `node_read`: read exact Nodes, descendants, fields, tags, and references
- `node_create`: create ordinary Nodes, outlines, definitions, and references
- `node_edit`: patch text, metadata, structure, definitions, and field values
- `node_delete`: move selected Nodes to Trash
- `outline_undo_stack`: inspect and explicitly undo or redo document operations

Node writes always use document commands. Tool helpers never mutate Loro or a
projection directly. Read and write scopes are explicit; an empty scope denies
all access. Definition resolution is deterministic and rejects ambiguous names.

`node_edit` uses expected revisions for optimistic conflict detection. Results
return stable Node edit handles for subsequent tool calls; final user text uses
normal Node references rather than internal edit syntax.

`outline_undo_stack` is an explicit world-state operation. Thread forking never
invokes it.

Memory adds no parallel model tools. Eligible root-user Turns use the same Node
catalog for explicit remember, update, and forget requests. Implicit
`node_search` and `node_read` projections filter canonical Daily Timeline Memory
through the admission-pinned visibility view; explicit user-supplied Node
references remain ordinary input. Memory graph writes are causation-checked as
specified in [`agent-memory.md`](agent-memory.md).

### Local Files And Commands

- `file_read`, `file_glob`, and `file_grep`
- `file_edit`, `file_write`, and `file_delete`
- `bash` and `bash_stop`

Relative paths resolve from the Thread working directory. Full Access permits
absolute host paths unless an explicit block removes the capability. File tools
return bounded content and persist oversized output in app-owned scratch space.

Ordinary text `file_read` bounds the observation rather than the source. It
classifies encoding and binary content from an 8 KiB prefix, streams only until
the requested line window, an extra-content signal, or the 200,000-character
projection budget is reached, then closes the stream. `totalLines` is known only
when the scan reaches EOF; `hasMore` and `lineTruncated` make incomplete views
explicit. The active Turn's `AbortSignal` reaches the reader; cancellation closes
the stream and propagates as cancellation rather than being rewritten as a file
failure. Editing and notebook parsing still require their independent 10 MiB
whole-file budget. Image `file_read` uses main's globally serialized native
normalization path: it accepts at most 256 MiB of source data and emits at most
2,000 px / 4.5 MiB of model input rather than base64-encoding the original file.
PDF and rich-document reads retain their own page, byte, output, and timeout
budgets; PDF source size is rejected before whole-file buffering, and rendered
page images are normalized serially through the same bounded image path.

PPTX is a dedicated in-process OOXML route rather than a MarkItDown route. It
indexes the ZIP central directory lazily and validates the package graph before
opening selected content. The presentation root must use a supported Transitional
or Strict PresentationML namespace, relationship types must exactly match the
corresponding OOXML allowlist, and every presentation, slide, speaker-note, or
chart target must have its expected package content type. It then reads only
those selected XML parts. Media, embedded packages, macros, and external or
lookalike relationship targets are not opened. Archive-entry, selected-part,
selected-total, slide-count, elapsed-time, and final-output budgets bound the
observation independently of the presentation container's total byte size, so a
media-heavy presentation is not rejected merely for containing large images or
video. The result identifies itself as structural text and explicitly excludes
images, visual layout, animations, embedded files, and OCR. Missing or malformed
OOXML fails as `invalid_pptx` before any optional converter probe.

Office ownership files such as `.~Presentation.pptx` and `~$Workbook.xlsx` are
not document content. Product file admission and `file_read` reject them with a
stable `temporary_office_file` diagnosis and name the original document only
when an exact same-directory sibling is verified; local search and recent-file
suggestions omit them. Raw `file_glob` and `bash` remain complete filesystem
views and do not hide these files.

`bash` executes through the host shell, streams bounded output, records process
identity, and may return a background handle. `bash_stop` addresses only a known
live process handle. Native command exit and filesystem errors remain visible to
the model.

### Web, Image, And Import

- `web_search`: bounded web or image discovery
- `web_fetch`: HTTP retrieval with redirect, size, and content extraction limits
- `generate_image`: configured image-provider generation
- `data_import`: preview and commit a validated import pack

Import commit requires a matching, unexpired preview identity. It writes one
staging subtree through the Outliner host and verifies the materialized counts.
The write carries the executing Item's causation.

### Core Control

- `request_user_input`: ask one to three short product questions on a root Thread
- `update_plan`: record a Turn-local execution checklist
- `get_goal`: read the current Thread Goal
- `create_goal`: create a Goal only when explicitly requested
- `update_goal`: mark that Goal `complete` or genuinely `blocked`
- `codex_app.automation_update`: create, update, view, or delete a host-owned
  Automation on a root Thread

`request_user_input` is not an authorization tool. It supports an optional
bounded auto-resolution timeout only for useful, non-blocking questions. Each
question has a stable ID, short header, one sentence, and two or three mutually
exclusive options. The model-facing schema asks for the recommended option first
and an English `(Recommended)` suffix, matching Codex. This is presentation
guidance rather than a wire invariant: the host accepts localized or omitted
suffixes and preserves labels verbatim for answer round-tripping.

At most one plan step is `in_progress`. Plans are Items within a Turn and do not
create durable work entities.

`codex_app.automation_update` uses one bounded exact schema and the same
revisioned host service as renderer commands. It never writes scheduler tables
from model code or introduces a permission profile. Scheduled execution and
standing authorization are specified in
[`agent-automations.md`](agent-automations.md).

### Collaboration

- `collaboration.spawn_agent`
- `collaboration.send_message`
- `collaboration.followup_task`
- `collaboration.wait_agent`
- `collaboration.list_agents`
- `collaboration.interrupt_agent`

These tools operate on child Threads as specified in
[`agent-subagent-threads.md`](agent-subagent-threads.md).

The runtime-wide `subagentTokenBudget` default creates one pool on the root-most Thread
that starts a delegated tree. All descendants, including isolated Skill children, debit
that pool; the top-level spawner's own Turns do not. The grant is fixed when the pool is
created, so setting changes apply only to new trees. `collaboration.spawn_agent` accepts optional
`max_total_tokens` as a positive safe-integer cap on that child's own contribution inside
the pool. With no ancestor pool, that explicit cap creates a pool of the same size on the
child; descendants join it. It creates no nested reservation or refund. Neither pool nor
cap occupies or modifies a Goal slot.

Collaboration views returned by `list_agents` and `wait_agent` include the live
pool-or-cap `tokensUsed` and nullable `tokenBudget` that controls the next refusal. Once
the pool or local cap is exhausted, new non-user Turn admission is rejected while
explicit user Turn admission and steering of an active Turn remain available. A pool
holder cannot spawn after pool exhaustion. `followup_task` atomically removes its mailbox
snapshot before awaiting admission, preserves concurrently queued messages, and prepends
the snapshot again if admission is refused. Goal continuation records the complete typed
refusal as a deferral; automation dispatch records it as a failed run. Completion and
failure finalization debit member and pool before exposing an idle admission window.
Budget rows are created only after earlier fallible spawn work under the Thread-tree
mutex; rollback deletes only rows created by that spawn before the mutex releases.

Pool-covered Turns feed the complete active-tree in-flight tally from the runtime
normalizer's own usage accumulation; diagnostics are inspection-only. Covered non-user
Turns re-read shared persisted usage through a native-kernel port carrying authoritative
`remaining` and the binding constraint's `used`/`total`; a tighter child cap uses the same
port. The kernel never computes snapshot differentials, so pool/cap denomination changes
are harmless. Explicit user Turns have no gate port or warning but still contribute usage
and accrue. The first model call is unconditional. Before later calls, and before steering
drain or a new kernel Turn boundary, 80% consumption admits one canonical steering notice
with actual figures. Reaching zero remaining interrupts only outstanding model work; a
terminal answer remains completed and racing steering remains undelivered. Warning
delivery failures log and degrade without changing Turn status. Completion and failure
accrual clear the corresponding live tally without an intervening await.

Collaboration spawn rejects a child deeper than `/root/a/b` and rejects a seventeenth
direct collaboration child from one Thread. Isolated Skill children are exempt from both
gates and the lifetime count. Both are fixed host constants with distinct typed errors.
Model-facing budget text remains token-denominated. Renderer transcript, Details, copy,
and Automation error surfaces classify stable error codes and translate budget failures
into localized resource-limit copy without token counts. The shared `Turn.error.code` set
is closed; unknown strings normalize to `runtime_failure`.

`collaboration.wait_agent` is event-driven rather than a model polling primitive.
It takes no timeout argument, remains locally blocked while children are running,
and returns for terminal child activity or steering. Its structured result batches
queued terminal outcomes, including final result text and errors, alongside the
current child tree. A queued outcome reads the exact child Turn that produced its
terminal event rather than whichever Turn is newest at delivery time. When the tree
is already idle, it returns immediately with terminal outcomes so a later parent Turn
can still recover completed work.

Every terminal outcome also carries a nullable `transcriptPath` — an absolute
app-owned path, never a workspace one — and the tool description directs the
model to read or grep that file with the existing file tools to verify or debug
a reported result. Isolated-Skill result envelopes carry the same
`transcriptPath` line. No reading tool is added for the account layer:
`file_read` / `file_grep` already cover it (the capability layer resolves
absolute paths, so no permission widens), and the path stays readable after the
child stops or exhausts its budget. `wait_agent` itself renders nothing — it
reports the path and returns. A null path means only that the artifact is not on
disk; the result is unaffected. The artifact's contents, naming, write model,
and lifecycle are specified in
[`agent-subagent-threads.md`](agent-subagent-threads.md).

### Skills

`skill` invokes one configuration-selected Skill by canonical identity. Skill
instructions may call other tools only when those tools survive the current
Thread catalog and explicit blocks.

## Result Contract

Capability tools return native model-tool results with human-readable content
and structured `details`. Tenon capability envelopes use:

```ts
interface ToolEnvelope<T> {
  ok: boolean;
  tool: string;
  status: string;
  data?: T;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
    details?: unknown;
  };
  instructions?: string;
  metrics?: { durationMs?: number };
  capabilityAudit?: unknown;
}
```

Validation errors are stable failures with recovery guidance. Owner-native
unavailable results identify the blocked action kind. Unexpected exceptions are
captured by the runtime and complete the Item as failed.

Visible tool output is bounded independently from durable structured details.
The runtime may shorten presentation without changing the recorded result.

## Execution And Audit

Tool availability is computed before provider execution from the canonical
catalog, effective configuration, Thread scope, and capability evaluation. A
tool absent from that result is not advertised.

Every tool call creates one canonical Item. Document mutations additionally
record exact Thread/Turn/Item causation in the document operation journal. File,
command, MCP, and dynamic-tool effects are auditable from their Items.

Completed tool Items are immutable. Retrying tool work starts a new Turn or
forked Thread and creates new Item identities.

## Security Properties

Tool schemas reject unknown fields and invalid bounds. Paths, URLs, shell input,
Node scope, and structured query expressions are normalized before execution.
Sensitive values are redacted from diagnostic output.

The security model is Full Access plus explicit unavailability, as specified in
[`agent-tool-permissions.md`](agent-tool-permissions.md). Tools do not implement
an approval mode or a second filesystem sandbox.
