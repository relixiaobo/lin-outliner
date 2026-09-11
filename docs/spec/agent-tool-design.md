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
implementation remain structural failures for root Threads. For delegated
Sessions, an extension contract with no runtime handler is inspection-only
runtime input: it is skipped and recorded as a bounded diagnostic so one
unavailable extension cannot kill the Turn.

Domain-owned tool handlers are contributed by their owning modules; `runtime/`
only distributes those contributions through the same assembly seam used by
extensions. The shell owner contributes `bash`, `task_status`, and
`task_stop`. Delegation adds no model tool; its built-in Skill uses the Bash
surface.
Future command families such as browser control land in their domain module and
contribute tools through this seam rather than adding domain logic to runtime.

## Canonical Catalog

### Outline

The Agent catalog has no document-native model tools. Persisted document work
uses `bash` and the public `outline` executable. The same capability registry
serves users, built-in Agents, external Agents, and desktop adapters; Host policy
classifies an admitted segment as `outline.read`, `outline.edit`, or
`outline.delete`.

The public model is independent of presentation and storage choreography:

- Node is the only content and tree identity.
- Field is a reusable typed definition; values belong to Nodes.
- Outline, Table, Cards, and Calendar are Views over the same Nodes.
- Operation is the atomic settlement and recovery identity.

The built-in Skill is a compact decision router. It teaches this model, the
narrowest semantic command, exact and bounded selection, direct syntax for
routine one-call work, one common `create` shape, destructive review, and
uncertain-settlement recovery. Exact schemas, uncommon options, structured
examples, accepted vocabulary, and receipt formatting remain executable registry
data. Routine syntax belongs in the Skill when omitting it predictably causes a
metadata round trip.

Reads use `outline get`, `outline find`, `outline export`, and
`outline watch`. One complete resource uses one semantic invocation; complex
state for that resource uses the same command with `--input -`. Dependent
resources use one `transact` ChangeSet with bindings. The Agent never replaces
either form with a shell mutation loop or intermediate identity lookup.

`create` owns complete Node-tree creation plus optional Field declarations and
View configuration. Same-name compatible Fields are ensured automatically.
`edit` owns convergent Node properties, tags, Field values, references, and
Sources. `define create|ensure|edit` is reserved for explicit reusable
definition work. `view get|set` changes projection only; `search
create|edit|run` owns saved and transient query behavior. Public Field and View
terms are translated at the CLI boundary and never expose Core tokens.
An exact, fully specified `view set` converges without a current-View read.

Discovery is progressive: Skill, then one matching `example`, then exact
command help, then a narrow `schema --path` fragment. Bare schema discovery
returns only a compact catalog. Full schema bodies are for integrations or a
concrete diagnosis, not routine task planning.

Routine exact export and Saved Search convergence remain direct Skill forms.
An export receipt proves the destination, byte count, and digest, so artifact
existence and hashing do not require follow-up shell commands. Normalized import
keeps its four meaningful stages explicit: inspect, plan with Diff and evidence,
exact apply, and verification. These stages are not collapsed because each owns
a distinct review or correctness boundary.

Recipes cover the complete semantics advertised by their intent. The complete
edit recipe includes references, complete View configuration includes grouping,
sorting, filtering, and display replacement, and the dependent transaction
recipe shows a later structural operation consuming an earlier binding.

An exact `get` includes the Node description and logical Fields by default. A
Field projection contains the reusable definition ID, public name and type,
typed values, and whether the value is inherited. It is attached to the owning
Node; storage `fieldEntry` Nodes are not part of the Agent's read model. The
bounded summary shows content, description, completion state, and compact Field
values needed for an ordinary read. An exact Operation lookup accepts `history
OPERATION_ID`; history summaries show recovery state. Recipe lookup recognizes
multi-word commands and infers the variant when exactly one recipe exists.

Idempotent Daily Note ensure and exact Trash or restore operations use their
semantic command directly without a pre-read. A user intent that applies one
change to every query match lowers to one bounded query target and one Operation;
it does not discover IDs and loop over them. The `edit bounded-query` recipe is
the progressive-disclosure entry for that shape.

A successful semantic mutation returns a compact committed-state verified
receipt with Operation ID, bounded handles, affected-set evidence, and recovery
command. That receipt is completion proof for covered postconditions; a separate
read is only for facts it does not cover. Unknown settlement is never retried:
the Agent follows the receipt's exact `history --idempotency-key` command.

Destructive or explicitly reviewed work uses one immutable preview and exact
apply. A semantic command such as `replace text`, `merge`, or `purge` is invoked
first with `--preview` and then once with the returned `--expect-diff` hash and
same idempotency key. Advanced ChangeSets use the lower-level `outline preview`
and `outline apply` artifact pair. The Diff hash, base revision, idempotency key,
and acknowledgement remain bound in both forms.

The built-in Source definition remains stable ID `field:source`. Source values
are ordinary Field value Nodes; public `edit.sources` hides that storage
orchestration without creating a parallel resource type. Asset leases remain the
specialized byte boundary and become reachable only through ordinary document
state.

Read-only delegated execution retains schema discovery and reads while Host
policy rejects `outline.edit` and `outline.delete` before process launch.
Built-in Agent mutations require the existing short-lived host attestation;
request-body causation remains untrusted.

Memory adds no alternate document tool or projection. Agent causation is attached
to the Runtime Operation, while memory publication uses the normal idempotent
settlement contract.
### Local Files And Commands

- `file_read`, `file_glob`, and `file_grep`
- `file_edit` and `file_write`
- `bash`
- `task_status`
- `task_stop`, shared with Agent orchestration

Every local file/process call uses its Tool Task's admitted `ExecutionAddress`.
An explicit absolute `cwd` wins. A relative override resolves against the selected
Project primary folder, otherwise the application default (the user's home directory).
Without an override, that selected base is the address. The Project ID, primary path and revision
are sampled before asynchronous admission work and retained with the task address;
a later edit cannot redirect an admitted or running operation. A missing or
redirected Project primary folder fails dependent calls without fallback, while a valid
absolute override remains usable. Relative file paths resolve from that address's
`cwd`. An explicit
absolute file path is canonicalized as the task's target independently of cwd.
File instruction collection follows that canonical target's parent and
ancestors, with nested applicability retained per target. Directory searches
use their canonical search root and label deeper uninspected scopes as unknown;
later file edits admit those exact target scopes. Following a symlink for a
content edit uses its referent. New files resolve through the nearest existing
canonical parent plus suffix.
Bash instruction scope remains its admitted cwd. Neither an unrelated cwd nor
Project membership supplies the rules for an absolute file target.
Full Access permits absolute host paths unless an explicit block removes the
capability. The selected Project primary supplies the default; ancestor lookup never
changes that default. Receipts retain the resolved address, canonical targets,
`ExecutionPolicy`, and immutable `ContextSnapshot` reference used at admission.
File tools return bounded content and persist oversized output in app-owned
scratch space. Relative attachment paths resolve from the same Host default;
per-Thread attachment edit copies and observations remain in managed scratch
storage with their own deletion lifecycle.

Agents delete local files and directories through ordinary Bash commands such
as `rm`, `rmdir`, or `git rm`. There is no dedicated deletion tool or automatic
Agent-trash copy. Removal follows the invoked command's semantics, including
symlink-entry behavior, under the existing Bash action blocks, delegated access
policy, execution isolation, and audit. Prior trash contents are ordinary local
files and are not automatically removed. Outline deletion continues through the
public Outline commands and its own operation history.

`resolveExecutionAddress` captures canonical targets and Git/directory scope
identities. `pendingExecutionContext` creates a frozen generation-0 snapshot
with unknown discovery; SHA-256 references cover the encoded address, policy
and snapshot. `ToolTaskStore` stores that complete context with the task before
execution. File operations use `ToolTaskService.runHostOperation`; Bash and native
launchers use supervised process tasks. Both retain the same immutable context
through terminal settlement and recovery. After task creation, the Host performs
bounded best-effort discovery for each admitted scope. It walks canonical
ancestors for `AGENTS.md`, `CLAUDE.md`, and `AGENT.md`,
records source hashes and Git observations, and persists one immutable generation-1
successor keyed by the S0 snapshot reference. Missing optional sources are a
complete empty observation; read or byte-limit failures mark the successor
unavailable with a degradation reason and never fail the already admitted task.
The task receipt remains pinned to S0; later provider publication consumes S1 only
at its own boundary. Discovery payloads are temporarily owned by the Tool Task so
an unfinished observation survives Thread turn cleanup. Foreground output
consumption clears task detail while retaining compact task truth and discovery
ownership, including collection still in flight. At delivery, admission and
successor payloads are copied into the consuming Thread before committing its
evidence; only then is the temporary owner pruned. Fencing and Thread deletion
drain outstanding discovery writes before pruning, without publishing evidence.
Restart recovery pages the persisted tasks lacking a committed successor with
bounded concurrency until all pages have been attempted; a failed payload write
remains eligible on the next restart. Committed successors are never recollected.
Snapshot reuse within five seconds revalidates both instruction sources
and the captured scopes' Git HEAD, ref, and status; a changed or unavailable
observation requires fresh discovery.

The Kernel's Host-only deferred-start callback lets local tools publish their
execution-start event after admission evidence commits. Receipt context stays in
private result metadata; the provider receives the ordinary tool result plus
later canonical execution-context publications, never the private digest tuple.
Relative renderer links use the completed Item's admitted cwd. Before admission,
relative paths have no invented base; absolute file links remain usable.

Task addresses record typed file targets and the admitted Bash cwd, but do not
reserve those directories. Capability ceilings and isolation govern permission;
there is no separate mutation-classification flag or process-lifetime directory
exclusivity for a development server, Git inspection, edits or checks. Native tools own their locks; external commands and
concurrent edits require normal inspection and coordination. Address evidence
marks Bash coverage as `cwd-only`, not arbitrary shell-effect containment.

A child's `parentTaskId` is an execution ownership relationship. Admission checks
that the active Session owns that parent; it does not grant a directory lock or
additional authority. Settlement, cancellation and restart drain child work before
releasing its parent's execution resources. A Host operation recovered without
terminal evidence becomes `lost` and is never replayed by assumption. Scheduler
capacity leases remain independent of directory identity.

Inherited worktree isolation comes from the explicit Host-owned Session or run
worktree metadata; the admitted `ExecutionPolicy` records the applied write
boundary. The Host validates the resource's registration and identity against the
task address before any file or shell mutation, including calls inside a
delegated Session that carry no isolation override. Containment uses that validated
resource's writable root; it is not derived from a Thread directory or a
best-effort ancestor match. File writes require both lexical and canonical
containment. A new file resolves through its nearest existing parent and records
the unresolved suffix; unreadable, cyclic, or dangling symlinks still fail
closed. Missing or mismatched isolation evidence returns structured non-success
before side effects, without falling back to an unrestricted address. See
[Task Execution Context](agent-delegation.md#task-execution-context).

Ordinary text `file_read` bounds the observation rather than the source. It
classifies encoding and binary content from an 8 KiB prefix, streams only until
the requested line window, an extra-content signal, or the 200,000-character
projection budget is reached, then closes the stream. `totalLines` is an integer
only when the scan reaches EOF and is `null` otherwise, including in the
model-visible output schema. These bounded reads remain successful partial
results; `hasMore` and `lineTruncated` make incomplete views explicit. The active
Turn's `AbortSignal` reaches the reader; cancellation closes
the stream and propagates as cancellation rather than being rewritten as a file
failure. Editing and notebook parsing still require their independent 10 MiB
whole-file budget. Image `file_read` uses main's globally serialized native
normalization path: it accepts at most 256 MiB of source data and emits at most
2,000 px / 4.5 MiB of model input rather than base64-encoding the original file.

A long-line partial read includes `nextCursor` and a file generation. Passing that
cursor with the same `file_path` continues inside the line without a shell byte-range
workaround. The cursor carries path identity, generation, original encoding, next
byte position, line and observed end. Initial reads and continuations share CRLF/CR
to LF normalization and line counting while advancing through original encoded
bytes. Both readers join code points and CRLF pairs across decoding blocks and
place cursors only after complete units. UTF-8 and UTF-16LE are supported; changed
sources return `source_changed`. Cursors cannot combine with `offset` or
`pages`. Ordinary line windows remain available. New Turn tool assembly and actual
context compaction invalidate read freshness on the active tool closures, so a file
whose earlier contents left model context can return its text again.

`file_grep` sorts paths before applying offsets. Content mode preserves the regex
and emits bounded regions around actual matches, including matches deep inside a
long line, plus `readLocations` with path, line, match byte offset and a `file_read`
cursor when the source bytes can be verified. UTF-16 search offsets are transcoded
by ripgrep, so those matches retain a line locator and no misleading byte cursor.
UTF-8 BOM offsets are adjusted by three bytes and use bounded positional reads.
UTF-16 matches are grouped by file within the search request and share one forward
decoding pass, stopping after the last requested preview window. Retained windows
are bounded; work does not grow with the sum of matching offsets. Each file batch
keeps its generation check and cancellation signal. Zero-width
matches still expose their matching line context, including at CRLF line endings.
Ordinary UTF-16 reads can continue through the line. Previews may be truncated and
multiple matches on one line may produce separate regions. Files/count modes remain
unchanged. Context rows stay distinct from match locations. Pages fit the shared
4,096-entry and 256 KiB serialized result-data limits including cursor metadata,
UTF-8 and JSON escaping. Partial pagination advances by entries actually returned.

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

`bash` executes foreground and explicit-background commands through one durable Tool
Task service. Each command has a Host task ID, owning Thread, source
Turn and Tool Item, command digest, supervisor nonce, bounded output, declared artifacts,
progress, factual exit result, and delivery state. The command text is not duplicated in
task storage. `task_status` reads an owned task for an explicit status or recovery request;
unhandled results are pushed, so it is not a polling primitive. `task_stop` stops an
owned running or settling task and revokes pending responsibilities even after exit
before delivery. Terminal tasks skip producer execution fencing; revocation addresses
only that Task's pending result, even if its producer has started another invocation.
A committed handling Turn keeps its owner. These tools never accept an Agent ID,
Session ID, or deprecated shell ID.

`bash.stdin` is an optional JSON string for both foreground and explicit-background
commands. Its child bytes are exactly `Buffer.from(stdin, 'utf8')`: empty is distinct from
omitted, and the Host adds no newline, quoting, expansion, delimiter, or normalization.
Admission rejects non-strings, unpaired UTF-16 surrogates, and more than 64 MiB of UTF-8.
The Host creates task state and capture first, writes with backpressure, and closes stdin;
early exit or write failure settles that same Tool Task.

Explicit-background Bash without `timeout` has no elapsed-time deadline. It stays
owned and running after the initiating Turn ends, until process exit, explicit Stop,
orderly application Quit, or a resource limit. A positive timeout bounds foreground
and background processes alike; foreground Bash defaults to 120 seconds. Delegated
Agent jobs retain their configured scheduling deadline. A nullable timeout is persisted
with the Task and passed to its supervisor; it is not an extremely large timer.
The pre-release Task store requires fresh development data for this format change.

Background execution is explicit. When `run_in_background` is omitted or false, the
`bash` Tool call waits for terminal settlement regardless of elapsed wall-clock time;
duration never changes the control flow because subsequent Agent work may depend on the
result. True returns the durable task handle immediately. If cancellation leaves a
foreground process group nonterminal in `settling`, the Host promotes that same task to
background visibility so teardown remains observable and controllable. This safeguard
does not background an ordinary successful foreground command. A foreground task that
is still queued responds to its Turn cancellation before spawn and settles the same task
as cancelled. Application shutdown closes admission, settles queued tasks before waiting
for in-flight start paths, then stops admitted process groups; no queued task can launch
after shutdown settlement.

The standalone supervisor owns the process group, nonce-bound identity, heartbeat,
bounded stdout/stderr files, stop request, and atomic quiescent final receipt. A Tool Task
does not become terminal or deliverable until declared artifacts settle, the tracked
process group is absent, and the final receipt is durable. Detached daemons can leave
that group; a terminal receipt does not prove every daemonized descendant exited. `settling` remains
nonterminal and cancellable when teardown or reconciliation is incomplete. A restart
reattaches to a matching live supervisor or consumes its receipt; authenticated process
absence without one becomes `lost`, while ambiguous identity remains occupied rather
than being treated as free capacity. Orderly Quit requests process-group teardown and
bounded drain. No command is replayed during recovery.

`task_status` keeps terminal state, exit status, and artifact references available
even when JSON escaping makes the captured output preview exceed the shared
result-data budget. It clips only the visible output prefix and sets
`outputTruncated`; stored stdout/stderr and task details remain unchanged.

`task_status` exposes active-process logs through a timestamped `observation`, while
`result` remains null until terminal settlement. Each observation freezes a log prefix
at its observed byte length, bounded by the existing Task detail ceiling. Scan the
complete-line prefix from its beginning before choosing the visible tail, so a display
boundary cannot lose multiline secret context. Growing captures also redact an unmatched
private-key opening marker through the observation's end; complete-value scanning keeps
its existing behavior. Large captures use the existing secret-scanner worker. Scanner
failure withholds raw text; an oversized or shortened capture yields a bounded omission
notice instead of falling back to an unsafe raw tail. Apply the existing JSON output
budget after redaction. Truncated or incomplete lines are omitted with an explicit truncation
flag. Reading does not stop the producer, rewrite raw logs, finalize artifacts, or create
a receipt. Terminal output continues to use the immutable sanitized capture.
The development Skill uses observations plus an appropriate endpoint/Runtime/UI check;
process existence alone is not readiness. It leaves verified servers running for the user
and commits explicit service handoff before reporting availability. Only an
unresolved launch, finite result, or explicit watch can require continuation.

Ordinary tool environments omit ambient Electron development control variables
(`ELECTRON_EXEC_PATH`, `ELECTRON_RENDERER_URL`, `ELECTRON_CLI_ARGS`,
`ELECTRON_MAJOR_VER`, `ELECTRON_USER_DATA_DIR`, and `ELECTRON_RUN_AS_NODE`). Explicit
admitted environment overrides still apply. Outline CLI exports remain available for
operating the owning application; a nested desktop resolves its own Runtime entry and
interpreter from its source/package instead of consuming a parent's CLI export as a
launch override.

Packaged execution may add Host-only environment such as `ELECTRON_RUN_AS_NODE` to start
the standalone supervisor. The supervisor removes those control keys before launching
the user shell while preserving the admitted workspace environment and Tool Task progress
channel.

Every Task stores requested isolation separately from actual enforcement. Pending
admission has a null result; resolved results are `sandboxed`, `unsandboxed`,
`unavailable`, or `rejected`. The receipt records platform, backend dependency,
canonical writable roots, protected Git object stores, profile digest, network
policy, and any actionable failure. Full Access without an OS boundary records
`unsandboxed`. Host typed-file boundaries and read-only capability never imply OS
process isolation. Task details and `task_status` expose this distinction.

For `macos-write-sandbox`, the trusted supervisor retains exclusive ownership of
its metadata outside the command's write roots. It applies `/usr/bin/sandbox-exec`
to the command through a fixed bootstrap. A private fd 4 acknowledgement binds the
Task nonce and profile digest after the kernel applies the profile; the bootstrap
closes that descriptor before executing user code. Private producer input remains
on fd 3. Missing dependencies reject activation before spawn. Missing acknowledgement
records `unavailable`, tears down the attempted process group, and never retries
unrestricted. The network policy is explicitly `unrestricted`; a write sandbox
is not network isolation. Protected Git object rules still allow only the
previously admitted object-creation operations.

Isolation request fields and a resolved outcome are immutable. Terminal receipt
version 3 and supervisor identity version 2 retain the activation result through
Host restart, terminal settlement, and output-detail expiry. Task storage includes
`isolation_json` and the execution-ownership `parent_task_id`. Retired directory
claims, private Git evidence and verification payloads have no legacy readers or
migration. Development runs need fresh clone-specific userData; never reset or
reuse installed Tenon data to test this change.

Admission uses durable `queued`, `active`, and `released` leases. Product limits bound
global and per-Thread execution plus producer/pool occupancy and queue length. Saturated
capacity records public queued progress. A background-capable caller receives that queued
task handle immediately while admission continues independently; foreground execution
waits for capacity. Queue overflow settles the same task before spawn. Initialization
reconstructs nonterminal occupancy before opening admission, and terminal commit releases
the lease in the same transaction. Queue wait time does not consume the command's process
timeout.

Producer-controlled stdout, stderr, progress text, artifact content, and future Runner
text are untrusted observations. Host task identity, state, timestamps, exit facts, and
resource references are application observations; only fixed Host handling rules are
application instructions. Unhandled terminal background results with an applicable
responsibility are atomically claimed in bounded
batches. The canonical `turn/started` event, keyed by stable batch, member, Turn, client,
terminal-digest, and envelope-digest identity, commits delivery. Startup rolls an
uncommitted batch back, links a matching committed Turn, and blocks only mismatched
members. A completion Turn that later fails remains the sole delivery and uses ordinary
Continue/Rerun recovery.

Task responsibility is separate from background waiting, process state, and user
attention. Bash `completion_agreement` defaults to `{kind: "result"}` for finite
jobs, including delegation. `{kind: "service"}` is allowed only for an explicitly
background root Bash process. It owes verified launch until handoff. A watch is
independent: `watchRequest` references an explicit reader Item, or
`"current_request"` resolves the latest reader request in the admitted lineage.
No command name, log, exit code, elapsed time, or final answer selects an agreement.

`task_control` is a root-Thread mutation. The Host binds its active Tool Item;
foreign Threads, historical callers, hidden/delegated Threads, and copied evidence
cannot control another owner. Every action has `task_id` and `operation_id`:

| Action | Required fields and accepted effect |
| --- | --- |
| `handoff` | `expected_revision`, one to eight `readiness` Turn/Item references to completed successful checks after this service's launch; complete launch, preserve watch and process ownership |
| `acknowledge` | exact immutable `event_id`; bind a pending result to the current Turn/Item before reporting it |
| `start_watch` | `expected_revision`, explicit reader `request` reference; create a distinct watch on a live service with no active watch; a later watch requires a newer reader request |
| `revoke_watch` | `expected_revision`, exact `watch_id`; revoke only that watch, leaving launch and the process intact |

The model-facing `task_control` input is `{ request: { task_id, operation_id,
action, ...actionFields } }`. A shared action definition generates closed nested
schema alternatives and exact admission; internal Task commands and receipts
keep their flat shapes. Admission reconstructs action fields and nested Item
references in the existing canonical order before operation digesting. JSON object
key order cannot change replay identity; changed values or readiness array order
still count as different input. `acknowledge` accepts only the common fields and `event_id`.
Wrong action fields receive `invalid_arguments` with a bounded contract field
path, required/allowed fields and repair guidance, without echoing rejected
values or arbitrary keys. Extra fields, including empty-string keys, are rejected
before canonical reconstruction at every object depth. Rejection performs no Task mutation. Provider conversion
preserves the closed action language through the existing Anthropic schema profile
and normal OpenAI/Google JSON Schema paths; this does not enable strict constrained
sampling. Historical provider arguments remain immutable.

Bash returns `evidence` references for follow-up checks. Launch progress and
`task_status` are not readiness checks. The Host validates reference identity,
ordering, successful completion and owning-Thread provenance. The exact Task ID
and Item references associate the check with the service; cwd equality is not
an eligibility rule and grants no authority. Independently admitted checks may
run in another directory or after a Project primary-folder change without redirecting
either execution. Foreign/copied, missing, forbidden, unfinished, failed and
pre-launch evidence rejects; live-target, revision, Stop and receipt replay rules
remain with the Task owner. Expected rejections use `readiness_unavailable`,
`readiness_ineligible`, `readiness_unsuccessful` or `readiness_before_launch` with
bounded recovery instructions through the existing tool error envelope.

The Host does not certify arbitrary command/output semantics. The development
Skill requires a check of the requested behavior against the exact application's
isolated Runtime/content roots and advertised endpoint, without auto-starting or
repairing it. A healthy frontend or sibling Runtime cannot prove that a failed
application serves its workspace. Preserve the actual hostname/address family;
an IPv4 refusal from an IPv6-only listener is not a process-crash diagnosis.
Report partial startup and preserve evidence when application verification fails.
An authorized reset uses the existing process/managed-content owners and an
absence check, then requires the same application verification after restart.

`task_status.continuation` exposes revision, handoff, watch, Stop provenance, and
event facts. Its optional `operation_id` reconciles an exact receipt read-only;
`requestReference` identifies the latest reader request. After caller authorization,
identical operation replay returns the persisted receipt before fresh preconditions.
Different input under the same identity rejects. New stale operations return a
bounded conflict receipt. An already handled/admitted event returns its existing
handler. Receipts and responsibility commit atomically in the existing Task row;
a failed write leaves work pending. Retain at most 256 distinct receipts per Task,
reject new operations at that bound, and preserve old replay identities.

Every terminal digest identifies exactly one event: `pending`, `silent` with
`handed_off`/`watch_revoked`/`stopped`, `handled` with Turn/Item, or `admitted` with
completion Turn/batch. A handed-over unwatched service exits silently for zero,
nonzero, signal, or uncertain outcomes. Finite outcomes and unhanded launch exits
remain pending; an active watch also owes continuation. Revoking a watch cannot
suppress an unfinished launch. Silent outcomes have no fabricated delivery Turn.
Acknowledged results stay owned if their handling Turn fails or is interrupted;
ordinary Turn recovery applies, without an automatic second completion.

Task control and Stop serialize with final Thread admission under the existing
Thread mutex. The Host reconciles prepared batch identity before mutation and
checks current responsibility again immediately before the canonical Turn start
commits. Stop after exit can therefore silence an unadmitted event. Already
committed admission wins over a competing acknowledgement or Stop; other batch
members keep their own handling. Reconciliation failures remain blocked, never
silent success. Restart preserves receipts, handoff, revocation, and disposition.

Stop provenance is persisted before requesting supervisor teardown: UI, Agent,
Host shutdown, or foreground Turn cancellation. The supervisor continues to own
immutable code/signal/time/process-absence facts. A close outside the Host may
have no known initiator; earlier stderr and shutdown errors cannot establish it.
Process observations expose responsibility without granting fresh repair,
monitoring, replacement, or restart authority. This Task format uses required
`continuation_json` and `control_receipts_json`; pre-release data needs a fresh
isolated directory, with no legacy reader or migration.

Captured output and Tenon-managed artifacts share a 64 MiB per-task detail ceiling.
Logical detail is capped at 1 GiB per owner Thread and content-addressed physical detail
at 8 GiB per application. New background-capable work reserves its ceiling before spawn.
Delivered, silent, and handled detail has a 30-day TTL and is pressure-evicted oldest-first; pending or
blocked evidence is protected. A storage refusal records required, reclaimable, and
protected bytes without spawning. The task detail UI offers a confirmed Host-owned clear
for eligible settled details; this action is not a model tool and preserves compact
terminal and delivery truth. Thread archive/delete and missing-owner recovery refuse or
tear down work rather than creating orphan processes or completion Turns.

Typed managed-output roots are snapshotted at launch and settled before terminal commit.
Every execution receives a distinct root, so concurrent commands cannot claim each
other's files. Artifact collection accepts physical regular files within the original
root, observes count and byte limits, records bounded warnings, and uses remaining task
detail capacity. Stable command history replaces current readable paths with durable
markers; native command exit and filesystem errors remain visible to the model.

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
different for root, forked, delegation, Automation, and concurrent Threads.
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

### Interactive Process Experiment

The bundled development Skill uses ordinary Bash and Tool Tasks. It does not add
a persistent terminal or silently install tmux. The repeatable macOS probe is
`bun scripts/probe-tmux-tasks.ts /absolute/path/to/tmux report.json`. It creates
fresh Task storage and private sockets, derives the session name from the owner
Thread, execution directory, and worktree identity, and writes a report containing
the exact commands and Task receipts. It never uses an existing user tmux socket.
To exercise the built supervisor in Electron's Node mode, run `bun run tool-task:build`
and supply `TENON_PROBE_ELECTRON` with the Electron executable path to the probe.

The macOS arm64 experiment with tmux 3.7c measured these properties:

| Property | Observed result |
|---|---|
| Default detached server ownership | Failed: the launch Task succeeds while tmux remains alive; stopping that terminal Task does not stop tmux. |
| Foreground `tmux -D` ownership | Host crash/reopen reconciles the same Task, supervisor, server PID, and named session without another start. |
| Same-directory control | Admitted independently of the foreground server. The probe records both Task IDs and the identical cwd; no alternate control directory or capability fallback is used. |
| Duplicate named session | The second create fails; exactly one session remains. |
| Input and capture | `send-keys` is observed by the pane. Explicit `capture-pane` Tasks retain frozen earlier output; a 10,000-line workload yields a bounded tail within a 4 KiB preview. |
| Raw pane output ownership | Failed: pane output is not the server Task's stdout; uncaptured pane history is not retained as Task output. |
| Stop and explicit reopen | Stopping the foreground Task removes the tested cooperative server/pane. Clients use `-N` to avoid starting an absent server. Explicit reopen creates a new Task with one session. This does not attest to arbitrary detached or signal-resistant children. |
| Required macOS write isolation | The server records active isolation, but pane creation fails with `fork failed: Operation not permitted`. Pane writes cannot be exercised; the probe preserves the required profile and records this failed property. Ordinary isolated shell writable roots and protected Git objects are verified separately. |

Every session creation sets `-c` explicitly; a client's directory must not silently
change the pane's starting address. These failed properties mean tmux plus the
current Task API is not a supported persistent-session contract. A future native
terminal requires its own complete design grounded in these measurements; this
feature does not add one or relax capability/worktree restrictions.

### Web And Image

- `web_search`: bounded web or image discovery
- `web_fetch`: HTTP retrieval with redirect, size, and content extraction limits
- `generate_image`: configured image-provider generation

Ordinary web discovery uses fixed hosted search MCP endpoints over HTTP:
Parallel first, then Exa when the primary fails or returns no usable results.
The Host sends one JSON-RPC `tools/call` POST per eligible provider through a
credential-free Electron `Session.fetch` partition. There is no BrowserWindow,
homepage request, form submission, or page-script execution in this path.
No MCP SDK or external process is needed. Optional `PARALLEL_API_KEY` and
`EXA_API_KEY` process credentials are captured by the search client and sent
only in provider-specific headers; requests otherwise use anonymous access.
Endpoint redirects are rejected and credentials never enter result metadata.

The search client owns a 20-second total deadline, with at most 10 seconds per
provider including response-body reading. It accepts JSON and SSE envelopes,
requires the matching response ID, checks both JSON-RPC and tool errors, and
bounds each response to 512 KiB. Parallel's structured records and Exa's
explicit title/URL/text records become the existing title/URL/snippet shape.
Invalid or credential-bearing URLs are omitted, complete URLs are retained,
fragments are removed for deduplication, and the selected records fit a 64 KiB
JSON budget. Titles and excerpts are bounded; clipping is reported as truncated.
The reported result count describes admitted candidates, not the size of the
provider's search index. Bare and URL-form `site` inputs share URL domain
canonicalization, including internationalized domains, before provider hints
and exact/subdomain filtering. `recency_days` is encoded as a best-effort query
hint and still requires date verification.

A non-empty result set stops the chain. Empty success requires both providers
to return valid empty candidate sets; an empty response never erases another
provider's failure. Host details retain each provider's outcome and duration.
Exa's complete known empty-result message is accepted as empty and does not
trigger a provider cooldown; unrecognized trailing error text remains invalid.
Transport errors, rate limits, and malformed responses produce bounded error
categories without forwarding provider error text as instructions. Failed
providers cool down for 30 seconds, extended by Retry-After up to five minutes.
Repeated queries during an outage receive a useful failure instead of repeating
the same blocked requests or suggesting a query rewrite.

Successful non-empty searches are cached for 60 seconds, with at most 64
entries per client. Cache identity includes the effective query, result limit,
site, recency, and the date of a freshness cutoff; credentials are fixed per
client. Identical in-flight calls share a request, while each caller can cancel
independently. The underlying operation is cancelled when its final caller
leaves; cancelled work and failures are never cached. Cache and attempt
telemetry stay in Host details rather than the model result data.

Search titles and snippets remain untrusted discovery metadata. The Agent uses
`web_fetch` to observe a source URL's actual final URL, status, and content before
using it as factual evidence. Image discovery continues independently through
Bing Images, with its existing bounded browser extraction and transient retry.
The real Electron web-tool probe verifies ordinary HTTP search, the original
Chinese query, cache reuse without network, and no search-created windows.

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

`web_fetch` budgets model-visible find results after UTF-8 encoding and JSON
escaping. It retains complete match snippets and advances `nextMatchOffset` to
the first omitted match. Metadata text is bounded independently: individual
text fields use a 4 KiB JSON allowance and metadata uses 64 KiB overall. URLs
are kept whole or omitted, never shortened into a different address. Clipped
projections report partial status and truncation guidance; complete extracted
metadata and the original match window remain in Host details.

`generate_image` separates the provider's original artifact from the bounded image shown
to the model. It validates provider MIME/base64 against the 256 MiB source-image safety
boundary and admits the original into the shared ContentStore through an opaque Agent
reference. That original
is the `tiered` rendition of one immutable image artifact; it is not subject to the
generic 10 MiB per-image and 20 MiB per-call inline tool-output limits, so detailed 4K
originals remain intact until storage pressure makes them reclaimable.

All model-image producers decode actual source bytes through the common bounded
normalizer, including files stored without an image suffix. They preserve
canonical pixel orientation, aspect ratio and PNG transparency, without
upscaling or substituting OS thumbnails. Source reads and decoding retain the
source-byte budget; serialization and cancellation cover every producer.

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

Provider text accompanying generated images fits at most 16 parts within the
remaining 256 KiB serialized result-data budget. Truncation preserves Unicode
characters, reports partial status and a warning, and leaves saved images,
preview content, and complete provider text in Host details intact.

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

#### Native verification

The built-in `verification` Skill reads the acceptance criteria, repository
instructions and existing build/test configuration, then runs native commands
through ordinary Bash at explicit cwd. It inspects exit status and output,
corrects failures within the request, and reruns affected checks and required
gates. It bounds correction cycles procedurally and reports blockers and material
uncertainty. No check profile, exact-command registry, source manifest, private
verification database or completion admission engine exists.

Ordinary Goal objective/status, explicitly requested token budgets, continuation
accounting and budget wrap-up remain available. `create_goal` accepts no
verification configuration; `get_goal` reports Goal state/usage. Completion is an
Agent judgment supported by current evidence, not Host certification of a source
revision. Task receipts retain what ran and when; they do not authenticate every
later file state. Failed, missing or interrupted output is never a passing result.
Source changes can require reinspection/reruns; harmless reads do not mechanically
invalidate past results. Verification does not authorize publication.

`request_user_input` is not an authorization tool. Every call has a 60-second
whole-request deadline by default; optional `autoResolutionMs` keeps the existing
60–240-second bounds. Omission never means an infinite wait. Answered output has
`outcome: "answered"`, the exact request identity/deadline and all validated
answer-or-skip entries. Each entry contains exactly one option label, free text,
or `skipped: true`. An answered outcome records explicit form submission; it does
not imply that every question received an answer. Users can skip individual
questions, including all of them, without choosing an option or supplying text.
Skipped entries contain no withheld local draft content. Selection, editing, and
navigation stay local. Header arrows can browse unanswered questions. Next
requires an active answer for the current question and only advances locally; Submit answers
appears only on the final question and sends active answers with typed skips for
unanswered questions. Skip all sends only typed skips with `continue` intent and
retains existing answers locally. The protocol can carry supplied answers with
`continue` intent, but the Skip all UI never does so. A `discussed`
result has `intent: "discuss"`, active answers, and `messageItemId` referencing the
actual reader message admitted atomically and delivered through steering in the
same Turn. This is an explicitly supplied composite API request; ordinary
composer messages do not implicitly use it or submit question drafts. Discussion, skips, and continue intent do not
grant authorization. Timeout output has
`outcome: "timedOut"`, identity/deadline and no
`answers` field. Timeout is distinct from cancellation, failure, or approval; it
never fabricates Other text or chooses an option. The Agent continues authorized
independent work, states reversible assumptions when appropriate, or explains
the unresolved decision if nothing useful can proceed. Directional, irreversible,
and permission-dependent work still requires a real decision. Neither Host nor
runtime automatically re-asks an expired or skipped question. Skipping supplies no
answer and grants no authorization. Each
question has a stable ID, short header, one sentence, and an options array. An
empty array requests a pure-text reply; a non-empty array requires two or three
mutually exclusive choices. A one-option list is rejected. All questions can
receive free text, and the same answer envelope and recovery lifecycle apply. The model-facing schema asks for the recommended option first
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

### Project Organization

The Host-owned `ProjectService` owns Project sources/primary selection, lineage
membership, derived Project execution defaults and Automation deletion
fences. Both native UI operations and the built-in `projects` Skill use it.
The Skill invokes foreground Bash with the exact packaged CLI command
`delegate project --input - --output json` and separate literal JSON stdin.
No Project model tool is added. This command requires current Bash authority and
a live root user invocation; it remains available when delegation is disabled.

The request-bound private broker checks the source Thread/Turn/Item, supervised
Task/process identity, input digest and current capability before mutation. Project
proposals all use native confirmation with canonical paths and revision
revalidation. Binding selects the Project whose primary supplies subsequent task
defaults; there is no independent folder-setting operation. Durable operation
receipts report applied/pending/not_committed;
retrying the same ID and digest returns the original result. Inspection pages 50
Projects with a revision-bound cursor and separately includes the selected Project.
Neither a lost response nor a successful create followed by a failed bind implies
a completed combined change. See [Project catalog](agent-core.md#optional-project-catalog).

### Delegation And Tool Tasks

Delegation is a built-in Skill plus packaged CLI, not a model tool. When the
experiment is enabled for an eligible root Thread, the Skill teaches the model
to start and continue work through canonical `delegate` commands passed to
`bash` with literal JSON `stdin`. The command is always an explicit
background Bash Tool Task.

The model catalog never contains `agent` or `agent_message`. There is no
Agent roster, peer/main message route, model-selected Runner/model policy,
foreground delegated call, nested delegation, or Agent-form `task_stop`.
Task Profiles and access requests live in the CLI JSON contract; Host Settings
resolve Runner, model, effort, timeout, and scheduling policy before execution.
The complete Session, capability, continuation, and settlement contract is in
[`agent-delegation.md`](agent-delegation.md).

`task_status` and `task_stop` remain generic Tool Task controls. Completion
is delivered automatically, so models do not poll. A delegated execution result
is untrusted command output with a stable Session handle, terminal outcome,
bounded text/error, usage, artifacts, and worktree disposition. Only an explicit
later `delegate send` invocation continues that Session.

### Application Configuration

Agent configuration uses the existing ordinary file tools and the built-in
configuration Skill. Public source files, schemas, and current-Host status are
the contract: preserve unrelated content and distinguish saved, accepted, and
effective values. No Settings-specific model tools or Configuration CLI exist.

Skill acquisition/maintenance, Memory opening/reset, preview-local translation,
data cleanup, update checks, and diagnostics export remain user-interface
operations. Their internal Host services and IPC preserve live-window admission,
exact targets, native confirmation, cancellation, and settlement. They are not
published in the model catalog and have no Agent runtime adapters. The Skill
directs users to Settings, the preview controls, or App/Help menus for these
operations rather than inventing keys or touching private stores.

Global Memory enablement and Skill availability/source bindings remain public
file preferences. Memory content is ordinary Outline data. See
[Memory](agent-memory.md#user-surface), [Skills](agent-skills.md), and
[Preview translation](workspace-layout.md) for the retained user workflows.

### Skills

`skill` loads one configuration-selected inline Skill by canonical identity.
Skill instructions may call other tools only when those tools survive the
current Thread catalog and explicit blocks.

The effective presence of `skill` gates instruction invocation. When absent or
globally disabled, the Host emits no instruction catalog or Skill stable-prompt
module and does not recognize direct slash or natural-language Skill invocation.
A configured Skill name cannot bypass that gate. The human Skill Library retains
its independent registry and lifecycle service without granting instruction
invocation authority. Availability and source bindings use public configuration
files; installation and maintenance use the Library's reviewed operations.

A successful invocation returns only `{"status":"loaded"}` before its
supplemental instruction content is projected canonically. The result has no
execution mode, child outcome, Thread ID, or Agent Role. Skill frontmatter
cannot select tools, model, effort, or shell execution; retired execution fields
make that Skill unavailable rather than silently changing its behavior. See
[`agent-skills.md`](agent-skills.md).

For delegated `explore`, `plan`, and read-only `general` Sessions, retaining
a provider-visible tool is not permission to execute it. Bash and dynamic tools
are checked again against the frozen delegated action ceiling. Skill loading
cannot widen that ceiling.

## Canonical Call History## Canonical Call History

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

Host context such as the resolved task address, managed-resource and scratch
roots, environment, credentials, and private handles is never added to the
model arguments. `bash` history
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
corrupt text makes the whole value unavailable. Fork, rollback,
deletion, quota accounting, and startup reconciliation retain or reclaim both layers.
Truncation is never presented as an exact call. Projection replays the admission-time provider name and arguments without
consulting the current registry or schema; the schema digest is audit evidence only.
The whole call/result pair degrades to typed evidence only when a persisted argument,
complete output, or image dependency is unavailable. Item-specific fields are
presentation and audit projections only; no reverse mapper may recreate model
arguments from them. Payload shape and dependency checks are strict at publication and
decode. Fork materialization then treats missing semantic context, compaction,
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

Every tool in `MODEL_TOOL_CATALOG` returns a Host-owned semantic result. MCP,
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

Expected business refusals are explicit typed failures at the domain boundary,
not inferred from exception messages. ToolRuntime maps Goal, Thread-history, and
task-stop refusals, and the Automation adapter maps Automation refusals, into
semantic error envelopes. Aborts and every untyped exception continue to escape
to the Kernel as `aborted` or `execution_failed`; adapters never catch all errors.

`file_edit` and `file_write` project their structured patch before Kernel
validation. The model-visible projection admits at most 4,096 patch lines across
all hunks and stays within the shared 256 KiB result-data ceiling. If either
limit clips the projection, the completed mutation returns `status: "partial"`
with a warning and private `metrics.truncated`; the complete patch remains only
in Host-private `details.data`. A clipped presentation therefore cannot turn a
completed filesystem mutation into `invalid_internal_result`.

Durability transforms inspect only the first compiled Tenon header. They preserve
its exact bytes when no ephemeral path or image fact changes, transform selected
ephemeral fields without pretty-printing the result, and never parse later
supplemental text as JSON. Explicit text replacements may still apply to any part
when the producing tool declares them.

Visible tool output is bounded independently from durable structured details.
The runtime may shorten presentation without changing the recorded result.
The built-in Outline workflow uses deterministic default CLI receipts through
direct Bash invocations. Every capability declares a receipt family and known
results expose the identifiers, hashes, artifacts, omissions, and recovery
coordinates needed by their next documented command. Structured `--input -` bytes use Bash's
separate stdin transport; the command string contains only `outline` and its
arguments. Complete `--json` responses and exact Diff artifacts remain
available when machine fidelity is explicitly required.
Memory citation accounting accepts only explicit `outline --json get` output,
so bounded presentation changes cannot silently alter durable usage evidence.

## Conversation Records Through File Tools

Historical retrieval uses ordinary `file_glob`, `file_grep`, and `file_read`.
The model catalog has no Thread search/read tools, signed history cursors,
page-scoped citation selectors, or history-specific read action descriptors.
Composer keeps bounded, redacted `searchReferences` / `resolveReferences` metadata
and stable Thread markers. See [published conversation records](agent-core.md#published-conversation-records)
for eligibility, original owners, publication and lifecycle.

The stable prompt identifies `thread-records/index.tsv` and the current
conversation's `record.md`. Search the index for a conversation or the tree for
content, read its Turn, and follow complete-value paths. Explicit references resolve
to that same entry only when the effective file-read capability is available. Paths,
identity and historical content do not confer execution authority; current command
outcomes and process liveness still require native state and Tool Task inspection.

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

### Git Review And Explicit Publication

The built-in `git-review` Skill is a procedure over native `git` and `gh` through
ordinary Bash. There is no executable or Host-dispatched command named
`git-review`, private review-reference protocol, Git operation store or special
result card. Generic Task arguments, bounded output/artifacts, canonical history,
stop/recovery, capability blocks and observed process isolation remain in force.
Passive Host Git discovery still disables executable extensions and degrades
when safe inspection is unavailable; explicit native commands use ordinary Git
configuration, hooks, filters and signing under the admitted policy.

Review includes branch/HEAD, staged and unstaged diffs, selected untracked files,
binary content, renames, deletions and literal pathspecs. Literal-path inspection
uses shell-quoted `:(literal)` pathspecs after `--`, e.g.
`git diff --no-ext-diff --no-textconv -- ':(literal)selected'`, so it remains
admissible under read-only delegation without broadening the capability classifier.
A whole-file commit uses
explicit paths (`git --literal-pathspecs commit --only ... -- <paths>`), adding
only selected new paths first. This includes unstaged content of selected files
and preserves unrelated staged paths. A staged-hunk request instead requires
inspecting the full authorized index before ordinary `git commit`; the Agent
must not silently stage unrelated working content. Inspect immediately before
and after mutation, including the resulting commit and remaining status.

Publication requires intent for the operation and destination. Inspect the remote
URLs (`git remote get-url --push --all`), head/base, SHA and range; a named remote
may publish to multiple URLs, all of which must be covered by the request. Recheck
that list before the explicit-refspec push and query each actual push URL directly
before/afterward, including after a failed or interrupted push. A fetch-URL query
cannot establish the push destination's state. Track exact target refs/OIDs per
destination; partial or unreadable outcomes cannot become aggregate success.
Use explicit `gh pr create --repo --head --base --title --body-file`. Query
matching PRs before/after mutation, checking repository/head owner as well as branch
names. An interrupted response requires native-state reconciliation before another
mutation. Existing intended PRs are reused/reported; a closed/merged PR does not
implicitly authorize a new one. Missing or ambiguous results remain uncertain.

The Skill guides this procedure; the Host does not enforce immutable reviewed
bytes, authenticate a selected commit against a private snapshot, or guarantee
exactly-once publication across external clients. UI uses ordinary command results,
retained artifacts and the composer. Review and successful checks alone do not
authorize commit, push, PR creation, merge, release or deployment.
