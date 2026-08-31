# Agent Full Access And Capability Boundary

Tenon treats the agent as a delegated local operator. An accepted user request
authorizes execution of the tools visible in that Thread.

## Full Access

Available file and process tools execute with the host account's authority.
Relative paths start from the Thread working directory; absolute paths remain
valid. Shell commands run through the host shell. Network, provider, operating
system, and filesystem errors are returned natively.

Tenon does not add an agent filesystem sandbox, permission mode, approval policy,
or pause/resume authorization flow. `request_user_input` gathers missing product
input only and must never be used as a risk confirmation prompt.

This boundary is unchanged for child Agents. An `agent_message` to an Agent or
the reserved `main` route is task direction authored by a model, not user
authority. It cannot approve a plan, answer a pending user question, change
configuration or capability blocks, clear user-stop provenance, or turn a
denied operation into an allowed one. A recipient must refuse permission
laundering and surface the blocked need to the user through the ordinary product
flow.

That extends to Skills. There is no per-Skill ratification gate: a Skill does not
have to be accepted before the model may invoke it, and installing one enables it.
An accept-before-use step is an approval policy by another name. For a
user-initiated third-party install, consent is given once in the install review,
which shows what the Skill tells the model. A named product-default managed Skill
may instead be acquired and enabled by product policy as specified in
[`agent-skills.md`](agent-skills.md). Either acquisition path executes nothing,
but enabling the Skill puts its text into the agent's context.

Default availability does not widen execution authority. Browser Pilot remains
subject to the effective Configuration Profile or Role Skill ceiling, the
ordinary tool ceiling, `disabledSkills`, and explicit capability blocks. Its
preflight and every `bp` command execute through ordinary `bash` under Full
Access; missing network access, installer ownership conflicts, and operating-
system failures remain native command results. Chrome separately controls remote-
debugging availability and its connection authorization. Tenon adds no Browser
Pilot-specific approval mode or per-action bypass.

Creating or resuming an Automation is standing authorization for its future
occurrences under this same Full Access boundary. It introduces no separate
approval mode; schedule and dispatch behavior is owned by
[`agent-automations.md`](agent-automations.md).

Electron renderer security remains unchanged: context isolation, renderer
sandboxing, no Node integration, preload-only IPC, navigation denial, and the
permission allow-list protect the application boundary. Those controls are not
an agent capability mode.

## Capability Selection

Execution authority is shaped by four mechanisms:

1. The canonical model-tool catalog determines what the product can expose.
2. The effective Configuration Profile and Agent Role select a subset.
3. Parent configuration places a hard ceiling on every child capability source.
4. Explicit user blocks make matching action kinds unavailable.

Selection controls availability, not host-account authority. A tool that survives
selection runs directly; a tool that does not survive is absent or returns its
owner's structured unavailable result.

### Read-only delegated execution

`agent.execution: "read-only"` adds a Host-enforced action ceiling to one
delegated Agent. It is narrower than Full Access, is persisted in the Agent
execution policy, and is inherited by nested Agents and isolated Skills. A
descendant cannot clear it by selecting another Agent type, Role, tool list,
worktree mode, or Skill execution mode. Historical execution policies that
predate the field decode as mutable rather than being retroactively narrowed.

Static catalog selection removes direct file mutation and other tools whose
declared action kinds are not read-only. Read tools and narrowly scoped Host
coordination controls may remain visible so the Agent can inspect, report,
delegate under the same ceiling, and invoke a Skill without laundering
authority. At execution time, extension/MCP calls and dynamically classified
`bash` calls must consist entirely of read-only action kinds. File writes and
deletes, Outline mutations, local code or project-script execution, dependency
installation, background processes, network writes, publishing, destructive
cleanup, and unknown shell behavior return structured unavailability before
the underlying action starts. The ceiling does not rewrite commands or infer
safety from the Agent's stated intent.

For a Bash call with `stdin`, capability evaluation parses the command once and returns
both its action descriptors and one Host-private consumer class. Omitted input is
`absent`; the exact direct `outline add|commit|diff --input -` registry forms are
`registered-data`; known interpreter stdin-source forms are `executable`; every nested
shell wrapper, pipeline, alternate input source, or unproved consumer is `unknown`. Stdin text is opaque
to this classifier. Explore, plan, read-only, and worktree Agents reject `executable` and
`unknown` before spawn; `registered-data` remains governed by the command's ordinary
Outline read/edit descriptors, including the worktree mutation prohibition.

## Admission Is Not Permission

Full Access authorizes a valid operation exposed in the Thread; it does not make an
unknown tool or malformed argument object valid. Each provider call resolves the
canonical tool, normalizes model syntax, and passes that tool's strict schema before
capability evaluation. Unknown fields such as a model-supplied `bash.cwd` are rejected
once as `invalidArguments`, persisted only as bounded redacted correction evidence, and
never replayed as another tool call. The host still runs an admitted `bash` command in
the Thread working directory, but that directory is execution context rather than a
model argument.

The phases remain observable and separate:

- unresolved, truncated, or schema-invalid calls have no capability decision and no
  execution-start event;
- a schema-valid call matched by an explicit block retains its admitted call plus a
  structured `operation_unavailable` result and capability audit;
- a schema-valid unblocked call reaches the native tool under Full Access, where shell,
  operating-system, network, provider, and service failures remain execution results.

Identity resolution, strict-schema validation, and redacted-copy compatibility are
admission-time decisions. The resulting provider-visible name, arguments, and schema
digest are immutable history; later registry, schema, or block changes do not
retroactively turn a past admitted exchange into a denial or erase its result. Current
selection and blocks govern only new execution.

## Explicit Blocks

Blocks operate on normalized action descriptors such as outline read/write,
local file read/write/delete, shell execution classes, web access, publishing,
external messaging, Goal control, Agent orchestration, Skill invocation, image
generation. Import is not a separate model-tool action: a directly executable
`outline` Bash segment is classified from the executable public capability
registry. Local metadata, reads, observe, and `diff` are `outline.read`;
ordinary mutation porcelain is `outline.edit`; destructive capability, `apply`,
and `revert` also carry `outline.delete`.

Command matching normalizes whitespace outside quotes while preserving quoted
content and recognizes the executable after supported environment/wrapper
prefixes. Quoted examples, comments, and heredoc bodies do not qualify. Unknown
shell behavior is classified conservatively. Blocks do not silently rewrite a
command into a safer variant. An inherited worktree policy rejects any Bash
command classified as an Outline mutation before the process starts. For an
admitted built-in Agent shell Item, host attestation supplies mutation causation;
it does not override an explicit block or worktree denial.

Capability configuration is local host state. It is not Thread history and does
not travel through document synchronization.

## Native Failures

Operating-system denial, provider rejection, missing credentials, unavailable
network service, and command exit are execution results. The runtime records them
on the canonical Item and lets the model choose another available approach.

There is no fallback that asks the user to approve the same operation. Product
questions and capability failures remain separate flows.

## Capability Audit

Each executed or unavailable tool result records:

- canonical tool identity
- resolved action descriptors
- read or write access classification
- decision source
- unavailable code and reason when applicable

Audit data is attached to structured tool details and the corresponding Item.
Document operations also carry immutable Thread/Turn/Item causation in Core
transaction metadata.

CLI import commits preserve the same audit identity without accepting raw IDs
from the process or request body. After capability admission, the host issues a
short-lived, single-use token bound to the current Thread, Turn, and Bash Item.
Only the recognized commit process receives it, and the local API consumes it
before request-body parsing. A missing, expired, evicted, or reused token fails
without a document write.

Audit and diagnostics retain canonical identity, admission disposition, schema digest,
and redacted observable arguments. Raw secret-like model values and host credentials do
not enter Items, argument payloads, transcripts, renderer detail, or diagnostics. The
diagnostic capture boundary applies formatting-preserving structural redaction to a
provider adapter's serialized function-call argument field without promoting that copy
into replay. The
active Turn may retain exact admitted arguments in a transient provider-history overlay;
that overlay is neither audit data nor durable history and disappears before any later
Turn or restart.
When a tool selects a large textual argument for private storage, durable redaction scans
that whole standalone string with the same Secretlint policy while the remaining JSON
skeleton is scanned structurally. The selected location is then restored with only its
durable replayable or redacted text. Live Bash stdin keeps the validated provider bytes;
redaction cannot change consumer classification, capability descriptors, or execution.
The recommended Secretlint scanner preset plus complete private-key, legacy `sk-`, short
GitHub-token, Bearer, and JWT signatures identify known credential formats. Structured
redaction requires both a normalized credential field name and a credential-candidate
string; ambiguous bare `credentials` and `token` values additionally require at least 20
opaque characters containing letters and digits. Numbers, booleans, nulls, objects,
arrays, numeric strings, placeholders, and ambiguous free text remain ordinary. JSON-key
inspection is limited to serialized `args`, `arguments`, `body`, and `payload` strings
and never recursively interprets nested JSON strings. Rule, parse, and depth failures pass
through unchanged, so ambiguity cannot become a capability denial. Diagnostic copies are
budgeted and cooperative and never alter live provider bytes or request fingerprints. A
JSON pointer is recorded only when the persisted value actually differs from its source.

## Shared Resource Concurrency

Full Access does not imply unsafe coordination. Existing subsystem owners retain
their serialization rules:

- `ThreadService` serializes Turn acceptance per Thread.
- the standalone Outline Runtime serializes document ChangeSets and settles one
  durable Operation per accepted mutation.
- file tools use optimistic preconditions where their contract provides them.
- process handles identify exact live commands.
- external services enforce their own idempotency and consistency contracts.

Thread fork changes history context only. It does not compensate or reverse
effects on any shared resource.
