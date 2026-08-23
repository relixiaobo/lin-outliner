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

Core owns control and Agent-task schemas. Retained capabilities contribute
their established schemas. Configuration contributes the `skill` schema.
Extensions must provide complete schemas and cannot shadow a Core identity.

Registry assembly fails when a required schema is missing, a canonical identity
duplicates another, an extension uses an unsupported action kind, or provider
encoding would collide. Flat provider names use `namespace__name`; tool-name
components cannot contain the separator, making the mapping reversible. A
namespace identifies an MCP server or a plugin: host tools are unnamespaced, and
no host identity carries the name of another product.
Every concrete static catalog schema is compilation-guarded by the test suite.
Compiling is necessary but not sufficient: every model-facing schema must also be
one every provider accepts. That means an object root carrying no union keyword —
`oneOf`, `anyOf`, `allOf`, `enum`, and `not` are all refused at the root of a
function schema, while nested unions inside a property subschema are fine. Such a
schema is legal JSON Schema and compiles locally, so a static contract declares an
object-rooted schema in its type and cannot be written otherwise, the admission
boundary rejects both an unsendable root and a root union before exposure, and the
catalog guard asserts it for every static contract. A mutually exclusive argument
group is therefore expressed in the tool's decoder and its parameter descriptions,
never in the schema root. Which side of that boundary a schema
failure lands on is decided by ownership, not by the channel that registered the
tool: a host-owned schema — Core, capability, or configuration — is a structural
failure even when a dynamic factory contributed it, while extension and MCP-backed
schemas degrade to one bounded diagnostic.
`ToolRuntime` also compiles extension contracts and runtime implementations before
exposure. A malformed dynamic, extension, or MCP-backed schema omits only that
canonical contribution and emits one bounded diagnostic; valid siblings remain
available. A valid dynamic or extension implementation whose schema disagrees with
its canonical contract is omitted by the same boundary. Core/capability contract
mismatches, duplicate contracts, and enabled valid extension contracts with no
implementation remain structural failures for root Threads. For child Agents,
an extension contract with no runtime handler is inspection-only runtime input:
it is skipped and recorded as a bounded diagnostic so one unavailable extension
cannot kill the child Turn.

Domain-owned tool handlers are contributed by their owning modules; `runtime/`
only distributes those contributions through the same assembly seam used by
extensions. The Agent orchestration owner contributes `agent`, `agent_message`,
and `task_stop`; the shell owner joins the unified `task_stop` dispatcher.
Future command families such as browser control land in their domain module and
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
When an Agent write materializes the first stored value for an existing field
definition, it writes the complete parsed `RichText` through the slot boundary;
later reconciliation uses that same rich-text identity, including marks, link
destinations, and inline-reference targets. Reconciliation consumes stored
values by occurrence, so intentional duplicate values retain their multiplicity.
All Node catalog tools except `outline_undo_stack` execute inside one document
transaction; if they return an `ok:false` `ToolEnvelope`, document writes from
that transaction roll back while the original model-visible error is preserved.
`outline_undo_stack` is excluded because it owns explicit undo and redo
semantics. Undo and redo accept an optional `operation_id` stack-top guard. A
guard mismatch performs no mutation, so a caller requesting an exact reversal
must not fall back to an unguarded stack operation.

Node outline text represents an owner's effective non-list view mode with
`%%view:<mode>%%` on that owner's line. `node_read` and user-view context emit
the same directive for ordinary and saved-search owners; `node_create` and
`node_edit` persist it through `set_view_mode`. Omitting the directive from a
directive-capable complete root outline in `node_edit` means `list`; code-block
outline syntax cannot carry this directive and preserves its current mode.
Applying the effective mode again is a no-op and does not create a `viewDef` for
a list owner. The agent-settable vocabulary is the renderer's shared
renderable-mode list (`list` and `table` today). Requesting a core-known but
unrendered mode fails as `view_mode_not_available`, while preserving the same
already-stored mode on the edited root is allowed so unrelated edits can
proceed. An unknown mode fails as `invalid_view_mode` and names the allowed set.

Persisted view configuration serializes directly under each requested read root
at every requested depth, including depth 0. Configuration for descendant owners
is omitted from a recursive read to keep the bounded content traversal from
multiplying view metadata; reading a descendant as a root exposes its config.
The typed outline lines share the saved-search rule/operand shape but use a
view-specific namespace so they cannot be mistaken for document children or
query rules:

```text
- %%view:table%% Work
  - %%view-sort%%
    - field:: sys:updatedAt
    - direction:: desc
  - %%view-filter%%
    - field:: [[node:Status^field-definition-id]]
    - operator:: is
    - logic:: any
    - value:: Active
  - %%view-group%%
    - field:: [[node:Status^field-definition-id]]
  - %%view-display%%
    - field:: [[node:Status^field-definition-id]]
    - label:: State
    - width:: 180
    - visible:: true
    - order:: 0
```

`%%view-sort%%` accepts `field::` plus `direction:: asc|desc`;
`%%view-filter%%` accepts `field::`, an existing filter `operator::`,
`logic:: any|all`, and repeated `value::` lines; at most one
`%%view-group%%` supplies its `field::`; and each `%%view-display%%` supplies a
field plus optional view-local label, width, visibility, and order. Width is a
whole number from 112 through 520, and order is a non-negative
whole number. Custom fields use field-definition Node references or an active
field-entry id obtained from an annotated `Field::` line; supported system fields
are `sys:name`, `sys:createdAt`, `sys:updatedAt`, `sys:day`, `sys:done`,
`sys:doneAt`, `sys:tags`, `sys:refCount`, and `sys:owner`. A configuration header accepts only its
typed directive and the optional Node annotation emitted by `node_read`; tags,
checkbox state, descriptions, and other Node directives fail validation rather
than being discarded. Annotated `node_read` output puts the stored
sort/filter/display Node id on its typed line; group has no id because it is a
`viewDef` property.

Only ordinary nodes and saved searches own view configuration; code blocks and
references reject it before mutation. `node_create` applies typed configuration after creating the owner and before
entering its requested mode. `node_edit` treats the configuration present in a
complete editable outline as the desired config and reconciles it through the
existing add/update/remove/clear commands. Partial string replacements retain
untouched lines naturally; a whole-outline replacement must retain any config
that should survive. Semantic no-ops preserve the existing config Nodes, and
annotated sort/filter/display lines reserve their matching Nodes before
positional reconciliation. Sort/filter identity survives same-order edits when
the stored order permits it; display identity also survives insertion because
explicit display order can change independently. Display reconciliation
preserves placement metadata that this outline grammar does not expose, and a
new display field retains the order assigned by Core when `order::` is omitted.
Unknown directives, unsupported operands, invalid field references, and
ambiguous duplicates fail before mutation as `invalid_view_config` with the
recovery grammar. Inspection skips malformed persisted config entries rather
than failing the read; a later complete edit can heal them.

Tabular document content uses a parent with `%%view:table%%`, direct child
records as rows, `Field::` names as column identities, and their values as
cells. Fields present when an owner enters table mode initialize its visible
columns. Adding a field while the owner remains in table mode preserves the
configured columns; the Agent adds a `%%view-display%%` line for a new visible
column. Hiding a column uses `visible:: false` rather than removing its display
line, preserving the view-local label, width, order, and values for restoration.
The Agent does not simulate a document table with space-aligned or Markdown
text inside code blocks; small inline enumerations remain ordinary lists.

`node_edit` uses expected revisions for optimistic conflict detection. Results
return stable Node edit handles for subsequent tool calls; final user text uses
normal Node references rather than internal edit syntax.

`outline_undo_stack` is an explicit world-state operation. Thread forking never
invokes it.

Memory adds no parallel model tools. Eligible root-user Turns use the same Node
catalog for explicit remember, update, and forget requests. Implicit
`node_search` and `node_read` projections filter canonical Daily Timeline Memory
through the admission-pinned visibility view; explicit user-supplied Node
references remain ordinary input. `ToolRuntime` applies that visibility view to
the full projection, maintained projection index, and maintained text-search
index under the executing Item's causation. Hidden IDs leave the text index
before candidate selection, BM25 statistics, scoring, or limits; filtered and
unfiltered Threads therefore share the indexed `node_search` scorer, while
`node_edit` keeps sparse mutation effects. Memory graph writes are
causation-checked as specified in [`agent-memory.md`](agent-memory.md).

### Local Files And Commands

- `file_read`, `file_glob`, and `file_grep`
- `file_edit`, `file_write`, and `file_delete`
- `bash`
- `task_stop`, shared with Agent orchestration

Relative paths resolve from the Thread working directory. Full Access permits
absolute host paths unless an explicit block removes the capability. File tools
return bounded content and persist oversized output in app-owned scratch space.
When an Agent inherits worktree isolation, file and shell mutations are bounded
to the persisted worktree `path`, including in descendants whose current call
did not request a new worktree. File writes require both lexical and canonical
containment; an unreadable, cyclic, dangling-symlink, or otherwise unresolved
canonical path fails closed instead of falling back to the lexical check.

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
page images are normalized serially through the same bounded image path. A PDF
read extracts text from the whole document by default; the `pages` selector is
only for rendering page images or inspecting layout. When present, `pages` must
be a non-empty string before any file route runs, and PDF range validation
remains fail-closed. A valid `pages` string on a non-PDF file is ignored after
content-based routing, the normal type-specific read completes, and a
route-specific warning describes the result. Only line-oriented text reads use
`offset` and `limit`; image, notebook, presentation, and rich-document routes do
not claim pagination they cannot perform.

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
identity, and may return a background task handle. `task_stop` dispatches that
handle through the shared background-task registry; it also accepts a running
Agent ID. A shell task belongs to the Thread that launched it, while an Agent
target must be reachable through the caller's collaboration lineage. The owner
is resolved exactly, and an ambiguous Agent/shell identity is rejected rather
than guessed. Shell stop success and failure both return the native structured
local-tool envelope, so status, error code, recovery guidance, and metrics remain
available to canonical history. Native command exit and filesystem errors remain
visible to the model.

Final shell logs use the Thread artifact sink. A foreground saved log and the final log
returned by `task_stop` expose `persistedOutput` with a stable `resourceRef`, byte length,
and current readable `filePath` when available. A running background task exposes only
`temporaryOutputPath`; it becomes durable when it completes and `task_stop` observes it,
or when it is stopped. Capture is bounded by the same maximum 64 MiB artifact ceiling.
Crossing it kills the command and returns `output_limit_exceeded` without claiming a
durable output. Calling `task_stop` on an already terminal shell returns its real terminal
status and final artifact rather than claiming the task was stopped again.
The exit-time size check is authoritative even when a fast command finishes before the
watchdog's next poll. Stable command history strips structured artifact handles and
replaces any repeated `filePath` or `temporaryOutputPath` inside instructions and warnings
with stable markers. Typed managed-output roots are replaced with their root ids in
stdout, stderr, instructions, and warnings. `task_stop` uses the background task's
launch-time roots for this replacement even when terminal collection reports that a root
has disappeared. The same stabilization applies to `outputRef`, command aggregation, and
dynamic tool content; the live result alone contains the current paths.

Browser Pilot remains a managed Skill workflow over this same shell surface:

```text
Agent -> browser-pilot Skill -> bash -> bp CLI -> Chrome
```

On the first shell-environment request in a Turn, the managed-Skill environment
registry reads and caches the active managed runtime roots, then invokes only
contributors whose Skills are enabled, clean, and compatible. It builds and caches
the composed result separately for each tool-call execution. Stable host values
remain consistent across Skill-shell, foreground `bash`, and background `bash`,
while execution-owned output roots do not leak across commands. Browser Pilot
contributes only while its managed record is active. An active-root lookup or one
contributor failure is logged and omitted; the shell continues with the remaining
or ordinary environment, so an optional integration cannot make unrelated `bash`
unavailable.

Agent command-path precedence is explicit: `LIN_AGENT_EXTRA_TOOL_PATH`, validated
managed-Skill bin contributions, the inherited process `PATH`, then standard
fallbacks with `~/.local/bin` before Homebrew. The explicit override therefore
stays authoritative, while a Tenon-managed Browser Pilot command normally wins
over an incompatible command on the ordinary user path without overwriting,
moving, or deleting it. Before contributing `userData/browser-pilot/bin`, the
host requires it to be absent, empty, or contain only the owned `bp` and
`browser-pilot` links/shims resolving into the managed `versions` directory.
Unexpected contents reject that contribution rather than entering Agent `PATH`.

`BROWSER_PILOT_CLIENT_KEY` is a base64url SHA-256 identity derived from the
installation ID and Thread ID. It is stable across Turns in one Thread and
different for root, forked, child, isolated-Skill, and concurrent Threads.
`BROWSER_PILOT_OUTPUT_DIR` is a canonical private directory under Agent scratch,
scoped by Thread ID, Turn ID, and an opaque SHA-256 key derived from the raw
tool-call identity. The raw identity never becomes a path segment. The host
rejects unsafe Thread/Turn IDs and symlink escapes before launching the process;
the existing scratch TTL owns cleanup.

The same directory is contributed independently as a typed `declaredOutputRoots`
entry owned by the `browser-pilot` Skill. Environment variables direct the external
process but never authorize collection. Ordinary foreground `bash` snapshots the roots
declared by active contributors before launch and collects them after exit; embedded
Skill shell narrows the roots to that managed Skill. A background command retains its
launch snapshot, and terminal `task_stop` performs its collection after output closes.
Each command receives a distinct execution-scoped root, so a delayed background write
cannot be attributed to a concurrent foreground command; `task_stop` continues to use
the background execution's original root and snapshot.
The collector admits only new or changed regular files. It skips hidden control files,
symlinks, non-files, files above 64 MiB, entries beyond the 512-entry scan ceiling, and
artifacts beyond the 16-file result ceiling with bounded warnings. If the pre-command
baseline cannot be scanned completely, that root is not collected for the execution.
Contributor/root identity, canonical physical paths, and containment below Agent scratch
are validated; one invalid contribution is omitted without disabling ordinary shell
execution. Browser Pilot separately creates its root as a private per-Thread, per-Turn,
per-command execution directory and rejects symlink escapes.

These values, `BROWSER_PILOT_INSTALL_ROOT`, and `BROWSER_PILOT_BIN_DIR` are host
execution context. They never enter model parameters, tool arguments, canonical
Items, transcripts, or diagnostics. Tenon does not set `BROWSER_PILOT_HOME`, so
compatible clients keep using Browser Pilot's ordinary shared service, and it
does not set one Turn-wide `BROWSER_PILOT_REQUEST_ID` because request identity is
per command. The installation identity is cached only after a successful load;
a transient read failure drops that command's optional contribution and can retry
on a later command execution.

### Web And Image

- `web_search`: bounded web or image discovery
- `web_fetch`: HTTP retrieval with redirect, size, and content extraction limits
- `generate_image`: configured image-provider generation

`web_fetch` uses a credential-free Electron `Session.fetch` partition with
automatic redirect following, then applies its byte, timeout, and extraction
bounds before returning content. Requests present the configured Chrome user
agent, client hints, and content-negotiation headers. Chromium owns the complete
`Sec-Fetch-*` metadata set: the runtime must not mix navigation-only values with
the Fetch API values Chromium generates. Electron 42 leaves `Response.url` empty
for this path, so a redirect observer on the dedicated session records the
landing URL for result metadata and the existing cross-host hint; it does not
construct or replay redirect hops. The real Electron probe exercises local read,
metadata, and find modes, verifies a real 302 and a consistent Fetch Metadata
set, and retains public reachability checks. Tool-owned BrowserWindows do not own
the probe process lifecycle: later probes continue after those windows close,
and the run fails unless every expected probe name is recorded exactly once
before the flushed summary and explicit exit.

A successful binary response is written directly through the Thread artifact sink; no
flat `agent-web-fetch` file is authoritative. `binaryFile` contains `resourceRef`, MIME,
byte length, SHA-256, and a current `filePath` only when materialization succeeds.
Persisted result text retains the stable metadata and removes the path. Artifact
admission failure reports partial success and a warning without reclassifying the
completed HTTP request as a network failure.

`generate_image` separates the provider's original artifact from the bounded image shown
to the model. It validates provider MIME/base64 against the 256 MiB source-image safety
boundary and writes the original directly into the Thread resource store. That original
is the `tiered` rendition of one immutable image artifact; it is not subject to the
generic 10 MiB per-image and 20 MiB per-call inline tool-output limits, so detailed 4K
originals remain intact until storage pressure makes them reclaimable.

The same admission creates a model observation at no more than 2,000 px per edge and
4.5 MiB. The result returns a stable `artifactId`, a rematerializable readable path, the
source and observation dimensions, source-pixels-per-observation-pixel scales, and the
full observation-to-source affine matrix. Only the observation bytes are emitted as
provider image content. An explicit preview index maps that content back to sparse
provider results, and event admission verifies the bytes against the already-persisted
canonical artifact before reusing it. A failed sibling therefore cannot select the wrong
artifact, and a canonical observation is never encoded a second time merely to record
the tool result. Original or observation admission failure omits only that output and
leaves unreferenced writes for normal Turn cleanup. Typed Thread-resource quota and
filesystem-capacity errors degrade generic image persistence to `quotaExceeded`;
unrelated storage errors retain their identity.

Generated local images are displayed automatically, so the tool returns no Markdown image
syntax and does not ask the model to repeat them. When the user names a destination, the
model copies the returned path with the ordinary shell. File operations, Preview, copy,
export, and edit input resolve the original first and the observation second. Both
renditions materialize at the same stable extensionless artifact path, and consumers
sniff actual image bytes rather than trusting the path suffix. Persisted slim details
and persisted model-facing result text retain artifact identity and image metadata, not
the live path. Historical projection derives its only readable path from the artifact in
the current Thread. If materialization fails, projection records the failure, omits that
path, and still sends an available bounded observation; if the observation is missing,
it emits an unavailable identity without failing the Thread. Generated originals are reclaimed only by the
Thread's pressure-based image retention policy; the seven-day TTL applies only to
reproducible scratch materializations.

Image artifacts expose the observation dimensions, source dimensions, scale factors,
and exact observation-to-source transform to the model. This is sufficient to relate
positions in the bounded observation to the admitted source-image pixel plane and to
diagnose scaling mistakes. The image artifact layer does not inspect, validate, convert,
or rewrite later tool arguments. Any additional coordinate semantics belong to the tool
that consumes them.

### Import CLI And API

Bulk import is not a canonical model tool. The built-in `tenon-import` Skill
coordinates inspection, deterministic conversion, validation, preview, and
commit through the CLI. Preview uses the running app's local API without write
authority. `AgentImportService` remains the internal document writer; it is not
exposed directly to the model.

The host recognizes only a directly executable `tenon-import commit` shell
segment, after optional environment assignments and `env`, `command`, or `exec`
wrappers. Quoted examples, comments, and heredoc bodies do not qualify. After
ordinary tool and Agent-policy admission, the host issues a short-lived,
single-use causation token bound to the current Thread, Turn, and Bash Item and
injects it only into that process environment. The CLI forwards it in a private
header. The API consumes an authenticated commit token before decoding or
validating the body, rejects missing, expired, evicted, or reused tokens, and
rejects request-body causation fields. Preview does not need a causation token.
Capability classification and token issuance consume the same parsed shell
segments. A recognized commit segment always contributes `outline.edit` before
generic shell classification without suppressing other recognized actions in
that segment, and the CLI rejects unexpected positional arguments plus unknown,
missing-value, or duplicate commit options before reading the pack or calling
the API.

Import Pack preview validation rejects tags duplicated after trimmed,
case-insensitive normalization and fields duplicated after canonical field-name
normalization. Multiple values in one field entry remain valid.

Materialization executes as one public document transaction even when yielding
and committing internal chunks. Any materialization exception rolls back its
projection, operation history, and all document writes. A successful commit
returns `status: "staged"`, one staging root, and the transaction's stable
`operationId`.

Post-write verification is different from a materialization failure. A count
mismatch preserves the single written staging subtree and returns an `ok:false`
API response whose data has `status: "staged_with_errors"`, `stagingRootId`,
`operationId`, `mismatches`, and `retryAllowed: false`. The CLI preserves that
data while exiting non-zero. The Skill must stop, avoid retrying or manually
deleting the subtree, and report those values to its parent Agent. An exact
reversal uses `outline_undo_stack` with the returned `operation_id`; the
stack-top guard refuses rather than undoing a newer operation.

Worktree-isolated Agents may run read-only import inspection and preview. A
shell command classified as a live-outline mutation, including
`tenon-import commit`, is rejected before process launch, so the host issues no
causation token and the local commit API cannot be used as a write bypass.

### Core Control

- `request_user_input`: ask one to three short product questions on a root Thread
- `update_plan`: record a Turn-local execution checklist
- `get_goal`: read the current Thread Goal
- `create_goal`: create a Goal only when explicitly requested
- `update_goal`: mark that Goal `complete` or genuinely `blocked`
- `automation_update`: create, update, view, or delete a host-owned Automation
  on a root Thread

`request_user_input` is not an authorization tool. It supports an optional
bounded auto-resolution timeout only for useful, non-blocking questions. Each
question has a stable ID, short header, one sentence, and two or three mutually
exclusive options. The model-facing schema asks for the recommended option first
and an English `(Recommended)` suffix, matching Codex. This is presentation
guidance rather than a wire invariant: the host accepts localized or omitted
suffixes and preserves labels verbatim for answer round-tripping.

At most one plan step is `in_progress`. Plans are Items within a Turn and do not
create durable work entities.

`automation_update` uses one bounded exact schema and the same revisioned host
service as renderer commands. That schema is a single flat object
discriminated by `mode`, with no union at the root, and each parameter's
description names the modes that take it. The per-mode field sets are exact and
are enforced at the write boundary by the tool's decoder, beside the Automation
input decoders the renderer path uses, so model input and renderer input meet one
set of bounds and one rejection vocabulary; a wrong-shaped call costs one round
trip and never reaches the service. The decoder addresses the Automation itself: a patch can
never carry the identity or the expected revision it is checked against. It never
writes scheduler tables from model code or introduces a permission profile. Scheduled execution and
standing authorization are specified in
[`agent-automations.md`](agent-automations.md).

### Agent Tasks

- `agent`: start one fresh Agent execution
- `agent_message`: steer or resume an Agent by ID, or send non-user traffic to
  the reserved `main` route
- `task_stop`: stop a background Agent or shell task by ID

These are top-level tools. There is no model-managed roster, inbox, follow-up,
wait, or polling tool. Child completion is pushed by the host as specified in
[`agent-subagent-threads.md`](agent-subagent-threads.md).

`agent` is exposed, and the Agent-type catalog is published, only when the
current Thread can actually spawn. A root Thread requires `agent` in its
effective tool set. A child additionally requires persisted nesting permission,
a non-leaf policy, and a requested-tool ceiling that admits `agent`; a Role's
configuration text cannot advertise an unreachable type. Role `tools: ['*']`
normalizes to an inherited ceiling, while Role `tools: []` is an explicit
zero-tool admission error that refuses before provider I/O. This does not change
the separate isolated-Skill authoring contract: its parser normalizes omitted
`allowed-tools` to an explicit empty array, which deliberately creates a
tool-free child.

`agent_message` and Agent-form `task_stop` never target the caller itself or an
isolated-Skill Thread. `task_stop` may address only a shell task owned by the
caller or an Agent reachable through the caller's collaboration lineage. These
address checks occur after exact schema admission and cannot be widened by a
display name, task path, or persisted execution row alone.

Claude Code evidence and Tenon contracts are intentionally distinct. The
committed Claude tool catalog is a sanitized projection. It supports only the
projected names, descriptions,
schemas, constraints, and raw key order. The canonical lowercase tools and
capability substitutions below are the closed Tenon normalization of that
projection; its `2.1.227` label is authoritative only when the fixture provenance
manifest binds its source digest to the exact capture run. The
`anthropic-pi-ai-serializer`
fixture is Tenon's adapter output and is not a
raw Claude request-byte fixture. Other provider families are compared at the
canonical contract before adapter conversion. Validation, summary fallback,
unified stop dispatch, and any behavior without a provenance-bound projection
remain Tenon-local compatibility contracts.

`agent` requires `description` and `prompt`. It optionally accepts
`subagent_type`, `model`, `run_in_background`, and `isolation`. Omission selects
`subagent_type: "general-purpose"` and `run_in_background: true`; these are
tool-owned argument normalizations before exact admission, not JSON Schema
defaults. `isolation`, when present, is exactly `"worktree"`. The model enum is
the active provider catalog, and its precedence is per-call, Role, then parent.

The complete `agent` description is a stored constant rather than prose assembled
at runtime:

```text
Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.

Available agent types are listed in <system-reminder> messages in the conversation.

When using the agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.

## When to use

Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.

- The agent's final report is not shown to the user — relay what matters.
- Use agent_message with the agent's ID to continue a previously spawned agent with its context intact; a new agent call starts fresh.
- Each agent type's model, reasoning effort, and tools come from its Tenon Role.
- `isolation: "worktree"` gives the agent its own git worktree (auto-cleaned if unchanged).
- Subagents run in the background by default; you'll be notified when one finishes or stops. Pass `run_in_background: false` only when your very next action depends on the result and nothing else could usefully happen while it runs — otherwise background it so the user can interject. Never fabricate or predict a pending agent's results — the notification is never something you write yourself; if the user asks before it arrives, say it's still running.
```

Its parameter descriptions are:

| Field | Description |
| --- | --- |
| `description` | `A short (3-5 word) description of the task` |
| `prompt` | `The task for the agent to perform` |
| `subagent_type` | `The type of specialized agent to use for this task` |
| `model` | `Optional model override for this agent. Takes precedence over the Role's model. If omitted, uses the Role's model, or inherits from the parent.` |
| `run_in_background` | `Agents run in the background by default; you will be notified when one finishes or stops. Set to false only when your very next action depends on this agent's result and nothing else could usefully happen while it runs — otherwise leave it in the background so the user can hand you other work.` |
| `isolation` | `Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo.` |

`agent_message` requires `to` and `message`; `summary` is optional. Its complete
description is:

````text
# agent_message

Send a message to another agent.

```json
{"to": "<agent-id>", "summary": "assign follow-up", "message": "continue with the follow-up"}
```

| `to` | |
|---|---|
| `"<agent-id>"` | Agent by ID |
| `"main"` | The main conversation (background subagents only) |

Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from agents are delivered automatically; you don't check an inbox. Use the raw `agentId` from the spawn result to steer or resume an agent. When relaying, don't quote the original — it's already rendered to the user.
````

The description's background-only wording is preserved from the captured
catalog projection; a version-bound foreground flow projection separately
shows that the handler accepts `main` from foreground Agents. `to` is described as
`Recipient: agent ID or "main"` and must match `^[^\n\r]{0,200}$`; after schema
admission, whitespace-only input receives `to must not be empty`. Lookup retains
the original string, including leading and trailing whitespace. `message` is
`Plain text message content`. `summary` is described as
`A 5-10 word summary shown as a one-line preview in the UI. Defaults to the first line of a plain-text message; longer summaries are truncated to 200 characters rather than rejected.`
Blank or omitted summary derives from the first line of `message.trim()`; any
submitted or derived value over 200 characters keeps 199 characters plus one
ellipsis. The normalized summary drives the handler and UI preview, while the
original tool-use Item remains byte-faithful.

`task_stop` intentionally has leading and trailing newlines in its description:

```text

- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- To stop a background agent, pass its agent ID as task_id
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task

```

Its optional `task_id` is described as
`The ID of the background task to stop. Background agents are also accepted by agent ID.`;
deprecated `shell_id` is `Deprecated: use task_id instead`. The schema omits a
`required` key. Runtime preparation requires at least one ID and gives `task_id`
precedence when both are supplied. It trims the selected ID, treats a blank
`task_id` as absent so a non-blank deprecated `shell_id` may supply the value,
and rejects an all-blank input as `Missing required parameter: task_id`.

All three schemas use JSON Schema draft 2020-12, `type: "object"`, and
`additionalProperties: false`. The required arrays are exactly
`["description", "prompt"]` and `["to", "message"]`; `task_stop` has none.
Canonical tool order is deterministic dictionary order before every provider
request. Provider families compare the canonical names, descriptions, and
schemas before adapter conversion. The Anthropic adapter uses Tenon's frozen
adapter key order; this is tested as a local conversion contract rather than
Claude full-request byte parity. OpenAI-family wire conversion remains adapter-
owned and retains the strict-field invariant.

The request budget, foreground/background lifecycle, exact launch and terminal
result envelopes, direct-parent notification, resume, stop provenance, depth,
concurrency, and transcript account are owned by
[`agent-subagent-threads.md`](agent-subagent-threads.md). They do not add fields
to these three model schemas. In particular, a successful foreground Agent that
produces no text returns `Agent finished without text output.` rather than an
empty text result.

A foreground `agent` call waits on the terminal-settlement authority for its
exact `{agentId, generation}`. The spawning call and the first terminal
reservation share one deferred even when the child settles before admission
returns. Its result is explicitly one of `settled`, `abandoned`, or `failed`.
Only `settled` permits the caller to read the final Turn and construct a
successful tool result.

The authority reports `settled` only when the current generation and Turn still
own a successful terminal pipeline. Outstanding background descendants are a
normal deferral. A notification Turn advances `currentTurnId` without advancing
the generation, so that transition preserves the reservation until the new Turn
terminalizes and revises it; it never settles the old Turn as the generation's
result. This keeps the foreground call waiting while descendant output is
pending or being consumed.

Initial-admission failure and terminal retry exhaustion report `failed`, with
the original admission error or the stable recovery error. Generation
replacement, Thread deletion, and service close report `abandoned`. Those
outcomes reject the foreground operation before it reads execution or Turn
state, so teardown cannot fabricate a successful Agent result. Foreground
settlement therefore consumes the level-triggered settlement state machine
directly; it does not maintain a second edge-triggered idle/activity predicate
or run a duplicate terminal pipeline wait afterwards.

The invoking Turn's `AbortSignal` races that foreground settlement deferred.
Abort still interrupts an active child Turn, but it also rejects the parent wait
when the child is already idle and there is nothing to interrupt. The terminal
settlement machine is not cancelled: it continues to record the child
generation independently after the parent stops waiting. Because the ordinary
foreground delivery tail no longer runs, every pending direct-root foreground
`agent_message("main")` row from that generation is claimed and discarded;
the independent settlement tail repeats that cleanup after the child reaches
terminal so a message racing the interrupt cannot survive. Background-delivery
rows keep their independent lifecycle.

### Skills

`skill` invokes one configuration-selected Skill by canonical identity. Skill
instructions may call other tools only when those tools survive the current
Thread catalog and explicit blocks.

The effective presence of `skill` is the admission gate for the entire Skill
surface. When absent, the host constructs no Skill runtime, emits no catalog or
Skill stable-prompt module, does not preload Role Skills, and does not recognize
direct slash or natural-language Skill invocation. A configured Skill name or
Role preload cannot bypass that gate.

An isolated Skill persists a foreground execution policy before its child Turn
starts. Its `allowed-tools` list is normalized into the durable requested-tool
ceiling, while Agent kind, worktree restriction, and nesting permission inherit
from the parent. The child source is `agent.skill`; its result returns only
through the owning `skill` call, and neither `agent_message` nor `task_stop` can
use its Thread ID as a collaboration address.

Embedded shell output has separate live and persisted renderings. The isolated child
may use current readable paths, while durable Skill invocation evidence contains only
stable resource references; occurrences of a typed output-root path in captured stdout
or stderr and artifact warnings are replaced by its stable root id. Typed managed output
roots are collected after the command even on a non-zero exit; every successfully
admitted file remains owned by the `skill` tool Item, and skipped or unavailable
artifacts are reported without inventing a ref.

For `explore` and `plan`, keeping a provider-visible tool is not permission to
execute it. `bash` may run only when every classified action is a proven
repository inspection. An extension or MCP tool may run only when every action
kind is classified read-only; an empty, unknown, mixed-write, or newly introduced
classification fails closed at execution and returns structured unavailability.

## Canonical Call History

Every raw provider call crosses one ordered admission boundary: resolve canonical
identity, freeze the provider-authored arguments for history, run that tool's
`prepareArguments` once when present, validate the resulting execution JSON exactly
against the exposed schema, persist the canonical history envelope, evaluate
argument-dependent capability blocks, bind host execution context, then execute. The
shared boundary never converts scalar types: `null`, strings, numbers,
integers, and booleans remain distinct; arrays retain order and cardinality; and unknown
fields remain present for schema rejection. Valid empty strings, zeroes, and false values
are not treated as missing. A tool-owned preparation may implement a specific public
normalization, but no generic layer performs coercion after it. The prepared value is
used for capability evaluation, execution, and Item presentation; the frozen original
remains the model-call history authority. This distinction lets a tool derive a UI-only
default without rewriting what the provider actually submitted.

Host context such as Thread `cwd`, workspace and scratch roots, environment,
credentials, and private handles is never added to the model arguments. `bash` history
therefore records its exact admitted `command` and optional model fields while
`commandExecution.cwd` remains host-owned audit metadata.

The immutable envelope has three dispositions:

- `replayable` stores canonical identity, exact provider-visible name, exact arguments,
  and schema digest.
- `redactedReplay` stores canonical identity, the same frozen provider name,
  structure-preserving redacted arguments, RFC 6901 redaction paths, and schema digest;
  execution receives the transient validated source value.
- `evidenceOnly` stores no replayable call, only identity when resolved, a bounded
  secret-redacted provider name and argument summary, a stable reason, and correction.

Exact JSON up to 32 KiB stays inline. Larger values use a content-addressed,
Thread-owned `toolCallArguments` payload and participate in fork, child inheritance,
rollback, deletion, and startup reconciliation. Truncation is never presented as an
exact call. Projection replays the admission-time provider name and arguments without
consulting the current registry or schema; the schema digest is audit evidence only.
The whole call/result pair degrades to typed evidence only when a persisted argument,
complete output, or image dependency is unavailable. Item-specific fields are
presentation and audit projections only; no reverse mapper may recreate model
arguments from them. Payload shape and dependency checks are strict at publication and
decode. Fork and child inheritance then treat missing semantic context, compaction,
managed-resource, tool-argument, and complete-output copies as recoverable: they retain
each canonical reference and the later projector emits typed call evidence or a bounded
context-degradation marker instead of aborting the user operation.
The codec requires the envelope on every tool Item. Pre-envelope Items have no migration,
fallback decoder, inspection helper, or replay path; pre-release userData is reset when
the format changes. Payload-backed arguments are available to renderer detail and Turn
copy only through an Item-bound main-process read of the exact reference, and are bounded
before renderer caching, formatting, highlighting, or copying. Inline arguments remain
complete. While a payload read is pending or unavailable, renderer detail and Turn copy
use the same typed unavailable value and never reconstruct arguments from Item
presentation fields.

Secret redaction compatibility is decided once against the admission schema. A
compatible copy freezes `redactedReplay`; an incompatible copy freezes executed
`evidenceOnly` while the validated raw source still reaches the tool. The active Turn
may overlay that raw admitted call transiently for its immediate follow-up provider
request, but later Turns and every durable surface see only the frozen disposition.
Cancellation stops each batch loop before it admits any remaining call, so those calls
create neither Items nor argument payloads.
The recommended Secretlint scanner preset identifies known credential formats, with
supplemental complete private-key, legacy `sk-`, short GitHub-token, Bearer, and JWT
signatures. Structured redaction normalizes complete
camelCase, snake_case, kebab-case, and unseparated credential-field spellings, but changes
a field only when its value is a credential-candidate string. Ambiguous bare
`credentials` and `token` fields require at least 20 opaque characters containing both
letters and digits. Non-string shapes, numeric strings, and environment placeholders
pass unchanged. Ordinary command and file strings use only high-confidence value
signatures. Formatting-preserving JSON-key inspection is limited to serialized `args`,
`arguments`, `body`, and `payload` strings; strings nested inside that JSON are never
reinterpreted as another JSON document.
Secretlint rule exceptions, unsupported asynchronous rules, malformed JSON, and scanner
depth failures pass through unchanged. Durable scanning yields cooperatively. Diagnostic
copies use one 64,000-character scan budget and typed omission markers without changing
live provider bytes or fingerprints. Redaction paths list only values that actually
changed, and diagnostic decoding is never a replay authority.

Provider call IDs are canonicalized before admission. The first non-empty unused ID is
preserved; an empty or repeated ID receives a fresh Turn-local UUIDv7. That canonical ID
is the only ID used by execution, Item causation, result pairing, and replay. The original
provider ID is retained only transiently to correlate the provider response part.

Deterministic admission rejection has a Turn-local containment guard. Its in-memory
fingerprint combines canonical identity (or the unresolved provider name), schema digest
when resolved, stable pre-redaction attempted JSON, and rejection reason; provider call
IDs are excluded. The first occurrence preserves the ordinary correction path. The
second identical `invalidArguments` rejection quarantines that canonical tool for later
provider calls in the same Turn. Each provider call freezes one
tool snapshot, and that exact snapshot governs both wire exposure and execution, so a
quarantined tool hallucinated later cannot execute. Different arguments, schema digests,
or reasons do not collide, and the guard resets on the next Turn.

`truncatedArguments` never quarantines. Truncation is a property of the response's
output-token limit rather than of the tool, and the rejection explicitly asks the model to
re-issue the call with complete arguments; removing the tool would answer that compliant
retry with an unresolved-tool rejection. It still counts toward the Turn-wide ceiling, so a
Turn that only ever truncates is closed by the ceiling instead of spinning.

Unresolved calls likewise contribute only to the Turn-wide ceiling because there is no real
tool to quarantine. At eight deterministic rejections, the kernel makes exactly one final request
with an empty tool list and then ends the Turn even if the provider emits another tool
call; that call receives bounded rejection evidence. Provider, persistence, capability,
permission, cancellation, and tool-execution failures do not increment this guard.

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

Tool exposure is computed before provider execution from the canonical catalog,
effective configuration, and Thread scope. Static blocks may remove a tool; a block
that depends on validated arguments returns a structured unavailable result after
admission. Schema failure is an admission error, not a capability or host denial.

Every admitted or rejected tool call creates one canonical Item. Document mutations additionally
record exact Thread/Turn/Item causation in the document operation journal. File,
command, MCP, and dynamic-tool effects are auditable from their Items.

Completed tool Items are immutable. Retrying tool work starts a new Turn or
forked Thread and creates new Item identities.

## Security Properties

Tool schemas reject unknown fields and invalid bounds. Paths, URLs, shell input,
Node scope, and structured query expressions are normalized before execution.
Secret-like model values are structurally redacted before Item, payload, transcript,
renderer, or diagnostics persistence. Host-injected secrets remain outside the
canonical call. Redaction keeps the successful outcome visible through marked replay
or executed evidence, so secrecy does not erase a side effect and induce a retry.

The security model is Full Access plus explicit unavailability, as specified in
[`agent-tool-permissions.md`](agent-tool-permissions.md). Tools do not implement
an approval mode or a second filesystem sandbox.
