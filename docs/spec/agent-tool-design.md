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

`collaboration.spawn_agent` accepts optional `max_total_tokens`; the host validates a
positive safe integer and uses it ahead of the runtime-wide `subagentTokenBudget`
setting. That setting defaults to `1,500,000`, accepts `null` to disable the default,
and applies uniformly to collaboration and isolated Skill children through their shared
spawn boundary. Enabled budgets create a host-owned ledger entry before the child starts;
they do not occupy or modify the child's Goal slot.
Collaboration views returned by `list_agents` and `wait_agent` include `tokensUsed` and
nullable `tokenBudget`. Once ledger usage reaches the budget, new non-user Turn admission
is rejected while explicit user Turn admission and steering of an active Turn remain
available. `followup_task` atomically removes its mailbox snapshot before awaiting
admission, preserves concurrently queued messages, and prepends the snapshot again if
admission is refused. Goal continuation records the complete typed refusal as a deferral;
automation dispatch records it as a failed run. Completion and failure finalization
accrue recorded usage before exposing an idle admission window. A budgeted spawner cannot
spawn after exhaustion; when it omits a child budget, the child receives the lower of the
global default and the spawner's remaining budget (or the remaining budget alone when the
global default is `null`). An explicit child budget still takes precedence because this
contract does not provide aggregate subtree accounting. A budgeted child also carries its
Turn-start ledger remainder into the native kernel. The first model call is unconditional;
before later calls, accumulated Turn usage at 80% admits one canonical steering notice to
synthesize and conclude, while usage at the remainder settles the Turn as `interrupted`.
Completion then accrues the usage normally, so the existing admission gate owns all later
non-user work. Unlimited children and root Threads do not activate these kernel ports.

`collaboration.wait_agent` is event-driven rather than a model polling primitive.
It takes no timeout argument, remains locally blocked while children are running,
and returns for terminal child activity or steering. Its structured result batches
queued terminal outcomes, including final result text and errors, alongside the
current child tree. A queued outcome reads the exact child Turn that produced its
terminal event rather than whichever Turn is newest at delivery time. When the tree
is already idle, it returns immediately with terminal outcomes so a later parent Turn
can still recover completed work.

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
