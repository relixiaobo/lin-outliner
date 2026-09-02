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

The Agent catalog has no document-native model tools. A model reaches the
Outliner through `bash` and the public `outline` executable. The built-in
`outline` Skill teaches deterministic selection, bounded reads, ChangeSet
composition, complete-resource porcelain, Diff review, Operation inspection,
and guarded recovery. Public schemas and exact root/family/command help come from
the executable registry; the Skill does not reimplement parsing, selection,
projection, validation, mutation, or command schemas.

`SKILL.md` is the Agent operating loop rather than a compressed command manual.
Its generated `references/commands.md` provides the complete family/command map
from the same registry; `references/changesets.md` and `references/import.md`
carry only the two advanced workflows. Selecting a command leads to exact
runtime help and `schema COMMAND`, so the Agent can learn the whole surface
without creating a second hand-maintained CLI contract.

The executable has the same capability registry for a user shell, built-in
Agent, external Agent, and desktop adapter. Agent execution does not receive a
reduced Selector, Projection, or Change union. Host capability policy classifies
the shell segment as `outline.read`, `outline.edit`, or `outline.delete`; ordinary
shell admission and explicit blocks still apply.

An Agent spawned with `execution: "read-only"` retains the same discoverable
public schemas but receives a Host-enforced action ceiling. Direct mutation
tools are removed, dynamically classified Bash/extension actions are checked at
execution, and every nested Agent or isolated Skill inherits the ceiling.
Outline reads remain available while `outline.edit` and `outline.delete` are
rejected before process launch. This is an orchestration policy, not a reduced
Runtime schema or a model-authored request convention.

For a built-in Agent shell call, main injects a short-lived attestation bound to
the Runtime descriptor and exact Thread, Turn, and tool-call Item. Runtime
validates it before a mutation and records immutable `built-in-agent` causation
on the Operation. Request-body causation is untrusted. A declared built-in Agent
mutation without valid attestation is rejected rather than downgraded to an
unattributed local-user write.

Reads use `outline find`, `outline show`, and `outline export`. The Agent routes
writes by resource boundary: one complete resource uses one porcelain invocation;
complex state for that resource uses the same command's `--input FILE|-`; multiple
resources, dependencies, cross-date work, or bounded bulk changes use one
ChangeSet with bindings. It never substitutes a shell mutation loop or an
intermediate created-ID query.

The schema exposes the built-in `URI` field through stable ID `field:source`.
Its entries and RichText value Nodes are ordinary, lazily created, editable, and
deletable through generic field and tree operations. The public CLI and
ChangeSet surface also exposes `source add`, `source replace`, `source reorder`,
`source remove`, and `source clear` as convenience adapters for resource
workflows. Replace preserves value identity and position, reorder/removal resolve
an owner-local direct value, and clear removes the observed values plus an entry
that becomes empty. Add and reorder follow the aggregate owner-local value order
across any converged entries. Parent deletion and concurrent editing follow
normal Loro tree semantics. Agents may use either generic field operations or
the convenience family; both must produce the same ordinary field shape.
Projection carries the exact URI in each value Node's
`content.text`. Preview, media search, local-file authorization, and asset
reachability recognize the definition ID, never the visible label.

The Skill distinguishes explicit create/add from convergent set/configure/ensure,
patch omission from explicit `replace`, and common STRING_MATCH shorthand from
canonical structured query input. It uses `@library`, `@saved-searches`, and
other stable aliases instead of discovering internal system IDs. It consults
exact command help for selector/cardinality and ownership boundaries:
`definition create` creates reusable definitions, `field define` attaches or
creates a target field with an optional initial value, `tag add` applies an
existing tag, root `set` patches generic Node state, and media/search set forms
own their resource-specific state.

For a common literal replacement, the model uses `text replace` rather than
inventing a shell loop or query language. One exact target needs no query; a
bulk transform uses STRING_MATCH or the canonical query with `many + max`, plus
the independent total replacement bound. The model previews and reviews the
affected set, applies the exact Diff, and relies on the base revision, rich-text
reference guard, semantic no-change, and exact revert supplied by the ordinary
ChangeSet path.

The model reviews a Diff, applies that exact artifact, records the returned
Operation ID/affected count/recovery state, and verifies consequential writes
with an independent read. Destructive porcelain uses preview plus the same
command's `--expect-diff HASH --yes`; `--yes` alone is invalid. Recovery names
the exact Operation with `outline revert`; it never guesses from renderer undo
state or issues an unrelated compensating edit.

Memory adds no parallel tools and no Agent-specific document projection filter.
Eligible root Turns receive compact routing context for ordinary CLI reads.
Runtime mutation observation uses trusted Operation causation, while Memory
publication and control-store settlement use idempotency receipts as specified
in [`agent-memory.md`](agent-memory.md).

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

`bash.stdin` is an optional JSON string delivered only to a foreground child. Its child
bytes are exactly `Buffer.from(stdin, 'utf8')`: empty is distinct from omitted, and the
host adds no newline, quoting, expansion, delimiter, or normalization. Admission rejects
non-strings, unpaired UTF-16 surrogates, more than 64 MiB of UTF-8, and any explicit
background combination before spawn. The writer attaches output, child, and stdin error
listeners before sending 64 KiB chunks, honors backpressure, closes stdin after the final
byte, and settles writer failure, early close, abort, timeout, and process termination
through the same foreground lifecycle. A stdin-bearing call never auto-backgrounds.

Final shell logs use the Thread artifact sink. A foreground saved log and the final log
returned by `task_stop` retain `persistedOutput` with a stable `resourceRef` in Host-only
result state. Their model-visible projection contains safe file name, MIME, byte length,
and current readable `filePath` when available, never the opaque reference ID. A running background task exposes only
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
flat `agent-web-fetch` file is authoritative. Host-only result state retains the opaque
resource reference; model-visible `binaryFile` contains safe file name, MIME, byte
length, and a current `filePath` only when materialization succeeds. Digest and opaque
reference ID never enter model prose. Persisted result text retains stable display
metadata and removes the path. Artifact
admission failure reports partial success and a warning without reclassifying the
completed HTTP request as a network failure.

`generate_image` separates the provider's original artifact from the bounded image shown
to the model. It validates provider MIME/base64 against the 256 MiB source-image safety
boundary and admits the original into the shared ContentStore through an opaque Agent
reference. That original
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

### Import Workflow

Bulk import is not a canonical model tool or private write API. The built-in
`outline` Skill's import workflow coordinates bounded source inspection,
optional cleanup, deterministic conversion, coverage accounting, Diff review,
one apply, and independent verification through the public `outline` CLI.

Bundled or Agent-authored source adapters may read source files and emit only
public `NormalizedImport` plus coverage. They have no Runtime client and cannot
mutate the document. Public `import plan` validates normalized data, generates
the generic ChangeSet, binds evidence, and writes the reviewed Diff. Every
source record must be mapped, intentionally skipped, merged, empty, or blocked;
unaccounted coverage prevents Diff review. Input that already matches the
normalized source shape bypasses cleaning.

Tana is the first deterministic adapter. Valid journal dates lower to `ensure`
bindings and native Daily Note targets in the same ChangeSet; non-date content
can share the same Operation under a staging root. Import is append-only and
does not imply deduplication or synchronization.

The Skill creates exactly one Diff artifact, verifies its ChangeSet hash and
affected set against evidence, then applies that exact artifact once. A
successful apply returns one ordinary Operation. Verification failure preserves
the committed content for inspection and reports the Operation ID; authorized
recovery uses guarded `outline revert OPERATION_ID`, never a shell mutation loop
or manual subtree deletion.

Worktree-isolated Agents may inspect source data and run read-only Outline
commands. Any shell command classified as `outline.edit` or `outline.delete` is
rejected before process launch, so the public CLI cannot bypass worktree policy.

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

Background notifications, peer messages, and exhausted nested settlement are
Host-started Turns with empty user input. Their metadata and handling rules use
application additional-context entries, while Agent-authored text uses an
untrusted observation entry. Projection records these entries as
`systemContext`, so no Agent-generated instruction, completion event, or
delivery retry can become user provenance or user approval.

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
from the parent. A parent `readOnly` ceiling is inherited as well and cannot be
widened by the Skill's declared tools. The child source is `agent.skill`; its result returns only
through the owning `skill` call, and neither `agent_message` nor `task_stop` can
use its Thread ID as a collaboration address.

Embedded shell output has separate live and persisted renderings. The isolated child
may use current readable paths, while durable Skill invocation evidence contains only
stable file display metadata and Host-only links retain the opaque resource references.
The Skill tool's model-visible artifact list likewise contains label, safe file name,
MIME, byte length, and an available current path, never the private reference ID.
Occurrences of a typed output-root path in captured stdout
or stderr and artifact warnings are replaced by its stable root id. Typed managed output
roots are collected after the command even on a non-zero exit; every successfully
admitted file remains owned by the `skill` tool Item, and skipped or unavailable
artifacts are reported without inventing a ref.

For `explore` and `plan`, keeping a provider-visible tool is not permission to
execute it. `bash` may run only when every classified action is a proven
repository inspection. An extension or MCP tool may run only when every action
kind is classified read-only; an empty, unknown, mixed-write, or newly introduced
classification fails closed at execution and returns structured unavailability.
When stdin is present, the same parsed Bash capability result also carries one
Host-private consumer fact: `registered-data` is allowed under the ordinary classified
actions, while `executable` and `unknown` are rejected by explore, plan, read-only, and
worktree policies. The stdin payload is never parsed to make that decision.

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
  schema digest, and the Host-private provider-call envelope.
- `redactedReplay` stores canonical identity, the same frozen provider name,
  provider-call envelope, structure-preserving redacted arguments, RFC 6901 redaction
  paths, and schema digest; execution receives the transient validated source value.
- `evidenceOnly` stores no replayable call, only identity when resolved, a bounded
  secret-redacted provider name and argument summary, a stable reason, and correction.

Exact JSON up to 32 KiB stays inline. A resolved tool may declare one private
large-text contract that selects a canonical ordered set of non-overlapping RFC 6901
paths after schema admission. Shared admission requires each path to resolve to
well-formed text, caps the set at 256 paths and 64 MiB aggregate UTF-8, and applies only
the fixed `secretScanText` durable policy. Tools without a contract preserve ordinary
storage behavior. Bash selects only `/stdin`, with one binding and a 64 MiB ceiling.

For a larger value, selected durable strings are written as content-addressed strict
UTF-8 dependencies. The Thread-owned `toolCallArguments` payload stores the remaining
JSON skeleton with selected locations replaced by `null`, plus canonical
`{ kind: 'internalText', path, ref }` bindings. The owning model-call argument envelope
declares the deduplicated reference set. When a complete Turn is nested in inherited
context, the owning context Item repeats those refs in its `internalTextRefs` manifest.
Dependencies are verified before the envelope
and owning Item publish; reference-set mismatch, an invalid skeleton slot, or missing or
corrupt text makes the whole value unavailable. Fork, child inheritance, rollback,
deletion, quota accounting, and startup reconciliation retain or reclaim both layers.
Truncation is never presented as an exact call. Projection replays the admission-time provider name and arguments without
consulting the current registry or schema; the schema digest is audit evidence only.
The whole call/result pair degrades to typed evidence only when a persisted argument,
complete output, or image dependency is unavailable. Item-specific fields are
presentation and audit projections only; no reverse mapper may recreate model
arguments from them. Payload shape and dependency checks are strict at publication and
decode. Fork and child inheritance then treat missing semantic context, compaction,
tool-argument, and complete-output payload copies plus unavailable linked resources as
recoverable: they retain each canonical reference and the later projector emits typed
call evidence or a bounded context-degradation marker instead of aborting the user
operation.
The codec requires the envelope on every tool Item. Pre-envelope Items have no migration,
fallback decoder, inspection helper, or replay path; pre-release userData is reset when
the format changes. Canonical replay rehydrates the exact durable value. Payload-backed
renderer detail and Turn copy use the enclosing Item-bound main-process read and one
shared path-aware 32,000-character projector, which reads bounded verified text prefixes
without building the complete bound value. Renderer projection exposes only
`{ storage: 'itemBound' }`, never context or internal-text references or binding paths.
Inline arguments remain complete. While a payload read is pending or unavailable, renderer detail and Turn copy
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

Every provider call receives a fresh UUIDv7 internal `toolCallId` before admission. It is
the only identity used by execution, Item causation, mutation, diagnostics, and durable
relationships. Provider correlation is independent: the first non-empty ID unused in
visible history remains exact, while an empty or repeated ID becomes
`tc_<internal uuid hex>` in both the active assistant call and result. Replayable and
redacted history store that selected provider-visible ID plus the source
API/provider/model and optional opaque `thoughtSignature`; their field bounds are 4 KiB
for IDs/source strings and 64 KiB for the signature. Over-budget live replay metadata
does not block execution: the active pair remains exact, while durable history becomes
executed `providerReplayUnavailable` evidence. Rejected evidence omits the active result.

Same-model projection restores the stored provider ID and signature. Cross-model
projection replaces the paired call/result IDs with the portable internal UUID encoding
and removes the signature before `pi-ai` serializes the target request. This mapping is
one-to-one and provider-neutral; Tenon does not copy provider-specific ID grammars.

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

The 22 tools in `MODEL_TOOL_CATALOG` return a Host-owned semantic result. MCP,
plugin, extension, and other owner-native dynamic tools retain their own result
content unchanged. The discriminant prevents a Tenon tool from bypassing the
semantic contract. An owner-native tool that returns the Tenon discriminant is
rejected as malformed; expected capability and policy refusals instead travel
through a private Host control-flow value, so result content cannot impersonate
Host ownership.

```ts
type ToolOutcome =
  | { ok: true; status?: 'unchanged' | 'partial' }
  | { ok: false; status?: 'denied'; error: { code: string; message: string } };

interface TenonToolResult {
  kind: 'tenon';
  outcome: ToolOutcome;
  data?: JsonValue;
  instructions?: string;
  warnings?: readonly string[];
  content: readonly (TextContent | ImageContent)[];
  details: unknown;
}
```

`ok` is the sole success discriminator. `status` appears only when it adds
`unchanged`, `partial`, or `denied` meaning. `data` is bounded decision data;
document/report text and images are ordered supplemental content. Family-owned
`details`, resource manifests, persistence replacements, capability audit, and
metrics remain Host-private.

Every catalog entry declares an `outputSchema`, or `null` when it returns no
data. Output schemas enumerate every visible field, close every object against
additional properties, and bound strings and collections under the aggregate
result ceiling. Descriptions never substitute for structural validation. The
Kernel validates the semantic result, enforces shared data/error/instruction/
warning limits, redacts secret-like header fields, and serializes exactly one
compact JSON header followed by supplemental parts in their original order. No
individual Tenon tool serializes provider-visible result JSON.

Expected tool failure or policy denial is an ordinary completed tool result with
`isError: false`, so its recovery guidance reaches the model. Unknown tools,
invalid arguments, cancellation, malformed internal results, and unexpected
exceptions are Kernel-owned failures with stable bounded codes and
`isError: true`. A malformed result degrades locally instead of killing the Turn.
Owner-native returned success and error content remain byte- and order-preserving;
only a failure created by Tenon's Kernel uses the common error header.

Durability transforms inspect only the first compiled Tenon header. They preserve
its exact bytes when no ephemeral path or image fact changes, transform selected
ephemeral fields without pretty-printing the result, and never parse later
supplemental text as JSON. Explicit text replacements may still apply to any part
when the producing tool declares them.

Visible tool output is bounded independently from durable structured details.
The runtime may shorten presentation without changing the recorded result.
The built-in Outline workflow uses deterministic default CLI summaries through
direct Bash invocations. Structured `--input -` bytes use Bash's
separate stdin transport; the command string contains only `outline` and its
arguments. Complete `--json` responses and exact Diff artifacts remain
available when machine fidelity is explicitly required.
Memory citation accounting accepts only explicit `outline --json show` output,
so bounded presentation changes cannot silently alter durable usage evidence.

## Thread History Tools

`thread_search` and `thread_read` are canonical `anyThread` Core tools. A default root
Thread includes both; child Roles and explicit `allowedTools` still place exact-name
ceilings on them. Search covers same-profile, non-ephemeral root user Threads, includes
archived Threads, excludes the current Thread, and returns 8 candidates by default with
a maximum of 20. Each result contains canonical Thread ID, current title, updated time,
a maximum 320-character redacted snippet, and an opaque HMAC-signed match cursor when a
visible history match exists. Searchable history includes visible user/assistant text,
bounded activity summaries, and resolved reference display metadata. It excludes system
content, reasoning, diagnostics, raw tool output, file locators, and secrets. The bounded
history-row budget is divided fairly across the candidate Threads before matching, so a
single long Thread cannot displace every shorter or later candidate from transcript
search. Each candidate read applies its share through the visible-history partial ordering
index and an index-backed `LIMIT` before rows are interleaved, bounding synchronous
database work without ranking complete histories.

`thread_read` validates a same-profile canonical target, excludes the current Thread,
and returns the newest page or the page containing a signed search cursor. A page holds
4 Turns by default and at most 10, uses a 24,000-character text budget, reports exact
coverage plus previous/next cursors, and never resumes, forks, wakes, appends to, or
changes read state on the target. Visible user/assistant text and concise activity
summaries are always treated as untrusted quoted context. Optional tool output reads the
real canonical `outputRef`, applies the shared secret scanner, removes bound historical
file markers and local paths, and caps each output at 4,000 characters. The payload reader
streams the complete file through UTF-8 validation, SHA-256 verification, and stable-file
identity checks while retaining only that bounded character prefix; it never materializes
the complete payload as a `Buffer` or string. A truncated prefix discards an unmatched
private-key block before ordinary secret scanning, then unconditionally discards its
complete trailing non-whitespace field after scanning. This preserves complete secret
terminators for the scanner while remaining independent of any guessed credential character
set, so the character boundary cannot expose a partial credential. Reasoning, diagnostics,
system input, provider envelopes, and raw unbounded output never enter the result.

An ordinary page read issues at most 20 display-metadata entries plus opaque page-scoped
citation keys; their serialized metadata shares the 24,000-character page budget. The
read creates no current-Thread link, retention anchor, materialization, or tool
`resourceRefs`. Keys expire after 15 minutes and are valid only for the same current
Thread, target Thread, page coverage, and still-present canonical resource. Selecting a
citation requires both `citation_key` and one representation: `reveal`, `replay`, `edit`,
or `observe`. A selection batch is validated in full before side effects, rejects repeated
citation keys, and resolves selections serially. The runtime revalidates each claim, links
only that resource, and returns it through the ordinary working-set contract. Reveal uses
a validated source; replay and observe use the exact revision. Edit reuses a source in the
current workspace or an admitted external scope, while a source in another managed root
is copied from validated exact bytes into a new current-workspace source. Same-name copies
claim their destination atomically and retry the next numbered name on an existing-file
race. The old managed root never becomes ambient access and its source is never edited.
Missing canonical citations do not trigger filesystem or profile-wide search.

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
