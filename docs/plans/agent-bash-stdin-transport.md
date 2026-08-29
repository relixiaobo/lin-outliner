# Agent Large-Text Arguments And Bash Stdin

## Goal

Settle one generic Thread-private representation for one or more large textual
values inside a tool's canonical JSON arguments, then use it to give the existing
`bash` tool one bounded, durable, literal stdin channel. A resolved tool owns
which structural argument paths are eligible and their admission policy; shared
Core owns storage, exact replay, dependency lifecycle, bounded presentation, and
renderer privacy without knowing a field name or downstream CLI.

The first public consumer is `bash.stdin`. The downstream public
`outline add|commit|diff --input -` workflow is owned and proven by the separate
`outline-cli-skill-efficiency` feature rather than defining this foundation.

This plan is shape **(a): one complete feature in one PR**. The generic
large-text binding representation, tool-owned admission contract, public Bash
field, effective-consumer classification, foreground stream lifecycle,
constrained-Agent policy, history and renderer behavior, current-behavior
specification, and focused tests ship together. The feature is independently
useful and verifiable before any Outline CLI or Skill optimization consumes it.

The objectives are:

- **OBJ-1:** Retain and replay a bounded set of already-supplied large textual
  tool arguments without embedding their escaped bytes in one context payload or
  exposing private references across renderer IPC.
- **OBJ-2:** Carry Bash UTF-8 input beyond the operating system's argv limit
  without quoting, delimiter, expansion, injection ambiguity, or a temporary
  file while preserving worktree, read-only, Plan, Explore, and explicit user
  block boundaries.
- **OBJ-3:** Preserve existing behavior for tools without a large-text contract
  and Bash calls without `stdin`, with one canonical settlement across
  publication, delivery, failure, interruption, fork/copy, and deletion.

## Non-goals

- Do not change the Outline CLI, Outline contract, built-in Outline Skill,
  Runtime, document storage, document renderer, Agent visual behavior, or Core
  document protocol. The separate `outline-cli-skill-efficiency` feature owns
  real Outline schema-capacity and end-to-end evidence after merge. Renderer
  changes are limited to the IPC protocol types, one store adapter, the existing
  tool-detail identity helper, and the existing Turn-copy storage-kind branch;
  no component layout, copy result, interaction, or rendering policy changes.
- Do not raise the 16 MiB Thread context-payload budget. Eligible text values use
  typed internal-text dependencies; the remaining JSON skeleton must still fit
  the existing context envelope.
- Do not make every string field eligible automatically. A resolved tool must
  explicitly register a bounded structural-path policy; tools without one retain
  the current inline-or-payload behavior byte for byte.
- Do not turn large argument text or stdin into an Agent file resource,
  ContentStore revision, source, workspace file, or public digest-bearing handle.
  Internal argument text stays under the existing Thread payload lifecycle and
  is not addressable by the model or a file tool.
- Do not add or invoke a file tool, temporary input artifact, named pipe, helper
  executable, environment variable, or shell heredoc as transport.
- Do not parse, inspect, or summarize stdin text for consumer classification,
  action derivation, authorization, or routing. Authority derives from the
  parsed command, the effective stdin consumer, and existing policy. The
  existing admission-time secret scan is mandatory but affects only the durable
  history copy; it cannot change the consumer class or live execution bytes.
- Do not add a new action kind or broaden `shell.local_code_execution` in
  worktrees. Ordinary worktree project scripts and local code execution without
  stdin preserve their current behavior.
- Do not add binary stdin in this feature. The public field is a JSON string and
  its child representation is the exact UTF-8 encoding of that string.
- Do not add background stdin. Explicit background input is rejected before
  spawn, and a foreground stdin call cannot auto-background.
- Do not change the generic Bash output projection, artifact retention,
  capability-block syntax, confirmation model, or retry policy.
- Do not claim to remove Provider or model output-token limits. This foundation
  removes host argv, durable argument-persistence, renderer IPC, and presentation
  transfer limits only for eligible text that has already been supplied within a
  tool-owned raw-byte budget. Moving existing large content without model
  re-emission remains the resource/reference lifecycle use case.
- Do not add migration, compatibility, or legacy tool-call readers. The optional
  field and internal representation extend the current pre-release schema;
  clean-reset verification replaces old readers.

## Design

### 1. Decision Summary And Existing Boundary

Current tool-call history keeps exact JSON up to 32 KiB inline and stores larger
arguments as one `toolCallArguments` context payload capped at 16 MiB. A single
large string can exceed that envelope through JSON escaping even when its raw
UTF-8 text is within a tool's valid input bound. The shared representation has no
way for a resolved tool to declare that one or more textual values should remain
Thread-private dependencies instead of being nested into the JSON payload.

Current Bash accepts `command`, `description`, `timeout`, and
`run_in_background`; both foreground and background spawns ignore child stdin.
Embedding structured input in `zsh -c` fails with `E2BIG` at the operating-system
argv limit and introduces quoting or heredoc-delimiter ambiguity. The public Bash
shape therefore adds a separate `stdin` string, while the durable solution below
is field- and tool-neutral.

`command` remains the complete executable authority. `stdin` is one literal
string delivered to that process after admission. No newline, terminator,
quoting layer, or other byte is added.

### 2. Generic Large-Text Argument Requirements And Bash Admission

- **FR-1:** `BASH_PARAMETERS` and `BashParams` expose optional
  `stdin: string`. Bash rejects non-strings, more than 64 MiB of raw UTF-8, and
  strings containing unpaired UTF-16 surrogates before persistence or spawn.
  The well-formed-Unicode rule makes the admitted string exactly recoverable
  from its UTF-8 bytes instead of silently replacing isolated surrogates.
- **FR-2:** The admitted child bytes are exactly `Buffer.from(stdin, 'utf8')`.
  Empty input is distinct from omitted input; line endings and Unicode are not
  normalized. Bash measures the raw value before JSON serialization and retains
  the 64 MiB bound independently of escaping.
- **FR-3:** A resolved `AgentTool` may expose one Host-private large-text
  argument contract. After existing preparation and schema admission succeed,
  that tool-owned policy receives the frozen canonical history value and returns
  a bounded ordered set of exact structural bindings. Each
  binding declares a canonical RFC 6901 JSON Pointer, `kind: 'internalText'`, a
  raw UTF-8 byte ceiling, and one approved durable-text history policy. The
  contract also declares maximum binding count and aggregate logical text bytes,
  both at or below the shared 64 MiB logical-text ceiling per canonical call;
  every individual binding is also capped at 64 MiB. The generic admission layer
  validates that every pointer is canonical, unique, pairwise non-overlapping,
  resolves to a string in the exact canonical value, and remains within the
  per-binding and aggregate limits. Invalid policy output fails before
  persistence or execution.
  Tools without this contract retain current thresholds and observable behavior;
  after the pre-release clean reset their payload codec uses the new generic
  envelope with no bindings.

  The initial approved durable-text policy is `secretScanText`; it invokes the
  existing scanner on the standalone string and cannot be replaced by a
  tool-provided callback. Adding another policy is a coordinated security-contract
  change. A tool selects policy data but cannot bypass durable redaction.

  Bash is the first consumer. Its contract selects only `/stdin` when present,
  permits one binding and 64 MiB aggregate raw UTF-8, uses the existing
  secret-scanned-text durable-history policy, and pairs that argument with the
  foreground child-stdin delivery behavior from FR-2 and FR-15 through FR-19.
  The validated provider-authored value remains a transient live-call overlay;
  durable history receives only the replayable or redacted string and records
  `/stdin` when scanning changes it. Classification and capability policy never
  read either text value.
- **FR-4:** For every call, generic admission validates the resolved tool's
  selected paths and applies each binding's approved history policy to its
  standalone string before structurally scanning the remaining JSON with those
  paths replaced. Scanner failure retains the existing fail-closed durable
  behavior. Admission combines the resulting RFC 6901 redaction paths and then
  chooses storage. Exact durable arguments up to the existing 32 KiB inline
  threshold keep the current representation and acquire no internal-text
  dependency. For a larger call, selected durable strings are stored as
  content-addressed UTF-8 under private
  `ThreadInternalTextPayloadReference`s. The stored `toolCallArguments` envelope
  contains the JSON skeleton with each selected location replaced by JSON `null`
  plus a canonical path-sorted binding array; the binding, not `null`, marks a
  replacement, so no sentinel enters user JSON. Payload-backed calls with no
  selected text use the same envelope with an empty binding array.

  The Host-only payload form of `ModelToolCallArguments` owns the context
  reference plus the deduplicated set of every internal-text reference used by
  its bindings. Multiple paths may reference the same content-addressed text,
  but logical bytes count at every path for admission. Publication writes and
  verifies every text dependency first, then the context envelope, then commits
  the owning Item. The binding-reference set and the Item-declared reference set
  must match exactly. An interrupted admission may leave reclaimable unowned
  payloads but cannot commit an Item whose complete dependency set was not
  published. The skeleton and binding metadata retain the existing 16 MiB
  context-payload limit.
- **FR-5:** Canonical consumers and presentation consumers are separate. Provider
  replay and internal recovery reconstruct the exact durable replayable or
  redacted `JsonValue` only after validating strict UTF-8, digest and byte length,
  canonical path order,
  unique/non-overlapping paths, a `null` skeleton slot at each path, reference-set
  equality, and every binding kind. JSON object key order is not identity. A
  missing, corrupt, undeclared, extra, or mismatched dependency makes the whole
  argument value unavailable; no consumer receives a partial reconstruction.
  Fork and child inheritance copy the verified dependency set without
  rehydrating its text.

  Payload-backed renderer detail, Turn copy, transcript, trajectory, and
  compaction use one path-aware main-process projector with one global existing
  32,000-character argument-display budget. It traverses the skeleton and
  canonical bindings deterministically, reads only bounded verified text
  prefixes needed for that result, and never constructs or `JSON.stringify`s the
  complete bound value. Payload-backed renderer reads move from
  `thread/context/read` to one Item-bound `thread/item/arguments/read` request
  containing only `threadId`, `turnId`, and `itemId`; the old context read refuses
  raw tool-argument envelopes. Its response is exactly
  `{ arguments: JsonValue | null }`, where non-null is already bounded and null
  is unavailable. Inline arguments never use this route and remain exact under
  the existing 32 KiB canonical admission even when pretty JSON exceeds 32,000
  characters.

  Canonical `Thread`, `Turn`, `ThreadItem`, `ModelToolCallHistory`, response, and
  notification types remain the Host/persistence authority. Distinct renderer
  `Thread`, `Turn`, and `ThreadItem` projection types replace every nested
  canonical Item recursively. Renderer model-call arguments have only two exact
  forms: `{ storage: 'inline', value: JsonValue }`, whose admitted canonical
  value crosses unchanged, or `{ storage: 'itemBound' }`. Every canonical
  payload-backed argument becomes the latter stub with no context reference,
  internal-text reference, binding path, digest, byte length, or storage path.
  The enclosing `threadId`, `turnId`, and `item.id` are the complete read
  authority; renderer caches and disclosure state use that identity.

  One exhaustive main-process projection module owns the only canonical-to-
  renderer Item conversion. Its shared Thread/Turn/Item primitives feed one
  response projector mapped by every Agent Core method and one exhaustive
  notification projector. The main-window request handler projects every
  response after `ThreadService` returns canonical state, and the single
  notification sender projects every event after Host-only subscribers observe
  it. Renderer/preload codecs accept only renderer projection types and reject
  private fields. Paged reads; start/resume/fork/rollback/configuration/detail
  responses; Turn submit/start/retry; and full Thread/Turn/Item notifications all
  cross that boundary. Methods and events without Items still pass the exhaustive
  envelope projector so future protocol additions cannot bypass it. Raw argument
  envelopes, canonical payload references, binding paths, internal-text
  references, and complete payload-backed bound text never cross IPC. Item-bound
  consumers receive only the bounded value; admitted inline arguments, including
  inline Bash stdin, cross unchanged.

The private canonical representation is generic and narrow. A
`ThreadInternalTextPayloadReference` carries only a content digest, byte length,
and fixed UTF-8 encoding. A `ToolCallArgumentsContextPayload` carries a JSON
skeleton plus zero or more `{ kind: 'internalText', path, ref }` bindings. The
payload-backed `ModelToolCallArguments` carries the context reference plus its
deduplicated internal-text dependency set, making the Tool Item the retention
owner. References and binding paths are unavailable through output, resource,
file-tool, renderer, or model-facing read APIs. The renderer Item stub is not a
retention owner. Existing Thread-private publication mechanics may be shared,
but argument text and tool output remain distinct semantic types.

This is a generic storage representation for eligible textual argument paths,
not a larger generic JSON payload, a downstream schema, or a second model-facing
input. It does not route any workflow through file tools.

### 3. Data-driven Effective Stdin Consumer Contracts

Adding stdin changes the meaning of some commands without changing their argv.
`outline ... --input -` consumes stdin as data, while `bash -s`, `sh -s`,
`python -`, and similar interpreter forms consume stdin as executable source.
An arbitrary executable may do either. Permission and constrained-Agent policy
therefore cannot use an absolute command-only rule.

One shared production classifier parses the command once and evaluates one
readonly `StdinConsumerContract` registry. It returns both the existing action
descriptors and one private stdin-consumer fact:

| Consumer | Meaning | Classification |
| --- | --- | --- |
| `absent` | `stdin` was omitted | Existing command classification, unchanged |
| `registered-data` | One direct registered command explicitly selects stdin as data | Existing direct-command actions; stdin text remains opaque |
| `executable` | A known interpreter form consumes stdin as program source | Existing command actions plus `shell.local_code_execution` |
| `unknown` | Stdin is present but the direct consumer is not registered or provable | Existing command actions plus `shell.unknown` |

- **FR-6:** Registered-data recognition is fail-closed, command-shaped, and
  registry-driven. Each immutable `StdinConsumerContract` matches one direct
  parsed argv shape and declares `registered-data`; it contains no payload text,
  persistence rule, tool-argument binding, or executor callback. The classifier
  factory accepts an explicit readonly registry so focused composition tests can
  inject a harmless data consumer without global mutation. Production uses one
  frozen registry whose initial entries match exactly these forms, with supported
  Outline global options before the command and exactly one literal `--input -`
  pair:

  - `outline [GLOBAL OPTIONS] add --input -`
  - `outline [GLOBAL OPTIONS] commit --input -`
  - `outline [GLOBAL OPTIONS] diff --input -`

  The three entries are registry data consumed after ordinary Outline command
  action derivation; they do not shape the generic large-text envelope or Bash
  writer. Additional argv is accepted only as ordinary arguments to that same
  direct command and cannot add another input source or shell segment. Compound
  shell commands, wrappers, substitutions, pipelines, redirections, duplicate
  input selectors, and extra shell segments cannot inherit a data registration.
  `outline show --selector -`, `outline show --projection -`, `outline apply
  --input -`, every other unregistered `--input -` command, and binary `outline
  asset ingest -` are explicitly excluded. No Outline code is imported into the
  transport writer.
- **FR-7:** Executable recognition covers the existing interpreter vocabulary
  and the argv forms that make stdin source code, including shell `-s`, Python
  `-` or no-script execution, and equivalent Node, Deno, Bun, Ruby, Perl, PHP,
  and AppleScript stdin modes. The classifier inspects argv only. It never reads
  payload text to decide whether the program appears safe.
- **FR-8:** An unregistered or ambiguous stdin consumer is `unknown`, not data.
  Future data consumers require one explicit command-contract registration and
  focused positive and adversarial tests.
- **FR-9:** Capability evaluation, user blocks, constrained-Agent execution, and
  audit consume the same classification result or the same shared helper. No
  second parser may independently decide that stdin is data or executable.

The existing `shell.local_code_execution` and `shell.unknown` action kinds are
sufficient. This feature adds no Core action kind and no public permission
vocabulary.

### 4. Policy And User-block Semantics

- **FR-10:** A `registered-data` call follows its direct command actions.
  Registered `outline diff --input -` remains `outline.read`; registered
  `outline add --input -` and `outline commit --input -` remain `outline.edit`.
  Stdin content cannot add or remove actions.
- **FR-11:** Worktree, read-only, Plan, and Explore Agents reject `executable`
  and `unknown` stdin before process launch. This is stricter than ordinary
  worktree local-code execution because worktree filesystem isolation cannot
  isolate a program supplied through stdin from the live Outline Runtime or
  another host service.
- **FR-12:** Worktree Agents may execute only registered-data stdin calls whose
  existing actions are otherwise permitted. A direct `outline.read` call is
  allowed; `outline.edit` and `outline.delete` remain rejected. Read-only, Plan,
  and Explore retain their current proven-read-only action requirements.
- **FR-13:** Root Full Access behavior remains default-allow. Known executable
  stdin carries `shell.local_code_execution`, unknown stdin carries
  `shell.unknown`, and direct data consumers carry their existing action kinds,
  so `Action(...)` blocks apply before spawn. Existing normalized
  `Command(...)` blocks continue to match `command` and never inspect payload
  text.
- **FR-14:** Rejection reports the effective consumer and blocked existing
  action without echoing stdin. It does not advise encoding, obfuscating,
  wrapping, or moving the same program into another transport.

### 5. Foreground Stream Lifecycle, Failure, And Recovery

- **FR-15:** Omitted stdin preserves `stdio: ['ignore', 'pipe', 'pipe']` and all
  current foreground/background behavior. Present stdin uses a piped child
  stream only after schema, capability, and constrained-policy admission.
- **FR-16:** Output capture and child error listeners attach before input
  delivery starts. The writer honors Node stream backpressure, closes stdin
  exactly once after the complete payload, and treats write, drain, early-close,
  and child-stdin errors as part of the same Bash settlement.
- **FR-17:** Abort and timeout stop input delivery and the process tree through
  the existing interruption path. Input failure cannot leave an unhandled stream
  error, report success, or start a second settlement. Native child exit and
  interruption evidence remain visible.
- **FR-18:** `stdin` with `run_in_background: true` fails before spawn. A
  foreground command carrying stdin is ineligible for auto-backgrounding. This
  feature does not create a durable background-input lifecycle or hand an
  unsettled writer to the background task registry.
- **FR-19:** Bash never retries a command after input or process failure. A
  caller follows the command's existing idempotency and recovery contract; the
  Bash result does not claim whether an arbitrary consumer applied a prefix.

### 6. Composition And Regression Evidence

Unit tests of the writer, binding codec, or classifier are insufficient because
the security and lifecycle properties exist only when provider arguments,
tool-owned binding selection, canonical admission, capability evaluation,
subagent policy, real Bash execution, and result settlement use the same facts.
Focused integration fixtures drive the real admission and root/delegated Bash
entry points with injected external authorities but production composition.

The fixture proves positive and negative authority:

1. a synthetic tool contract selects two nested textual argument paths whose
   NUL, backslash, Unicode, and delimiter-heavy values have worst-case JSON
   escaping; both values factor through the generic envelope, reconstruct
   exactly, and share no field-specific storage code;
2. duplicate, overlapping, aliased, non-string, excessive-count, excessive-byte,
   missing, extra, corrupt, and reordered bindings fail at the owning boundary;
3. one harmless injected `StdinConsumerContract` for a direct capture command
   whose ordinary classification is `shell.read_search` reaches that executable
   byte-for-byte and retains the existing read action for explicit blocks and
   constrained policy;
4. executable and unknown stdin never spawn in worktree, read-only, Plan, or
   Explore contexts; and
5. Full Access plus no matching block reaches the child once and settles once.

Real Outline schema maxima, the two-Node escaping/capacity case, and the actual
three-command CLI workflow are consumer evidence in #595. They are not generic
storage fixtures in this feature.

## Dependency And Collision Boundary

This foundation is a prerequisite of the separately planned
[`outline-cli-skill-efficiency`](https://github.com/relixiaobo/lin-outliner/pull/595)
feature. It does not depend on that feature or Source PR-I, and it modifies no
Outline path. The consumer PR rebases after this foundation merges and verifies
the public `stdin` and effective-consumer interfaces against real Outline schema
maxima. It owns the two-Node escaping/capacity and three-command end-to-end
fixtures. The plural structural binding envelope, internal-text dependency set,
canonical/renderer Item split, and rehydration contract are shared Core Agent
persistence and IPC-interface changes, so this generalized plan returns to PM
ratification before implementation. It does not alter the Core document
protocol, an Outline schema, or the Agent file-resource model.

The collision self-check found one open PR, `outline-cli-skill-efficiency`, whose
current plan discusses this missing interface but claims no generic Agent file.
That PR will retain only the observable Bash/consumer-registry dependency and its
own Outline evidence. No other open PR currently claims the expected files
below. A fresh `gh pr list` and actual-diff check run again immediately before
implementation.

## Implementation Boundary

Expected implementation ownership:

- `src/core/agent/protocol.ts`, `src/core/agent/codec.ts`, and
  `src/core/agent/modelCallHistory.ts` for the private internal-text reference,
  plural path-addressed argument bindings, declared dependency set, distinct
  canonical and renderer Thread/Turn/Item/model-call contracts, strict codecs,
  and Item-bound bounded-arguments read protocol;
- `src/main/agent/runtime/kernel/types.ts`, one new pure
  `src/main/agent/runtime/largeTextArguments.ts`,
  `src/main/agent/runtime/toolCallHistory.ts`, and
  `src/main/agent/runtime/types.ts` for the optional tool-owned large-text
  argument contract, generic selection validation, factoring, dependency
  declaration, and exact multi-binding rehydration;
- `src/main/agent/persistence/ToolPayloadStore.ts` for content-addressed internal
  text publication, verified reads/streams, copy, pruning, and cleanup;
- `src/main/agent/context/contextDependencies.ts`, `ContextCompaction.ts`, and
  `ContextProjector.ts` for dependency verification, inherited history, and
  replay projection;
- `src/main/agent/thread/ThreadCatalogOps.ts`, `ThreadResourceOps.ts`,
  `ThreadTrajectoryProjection.ts`, `TranscriptRenderer.ts`, and
  `TurnLifecycle.ts` for Thread inventory, fork/copy, Retry/rollback,
  reader-facing projection, orphan reconciliation, and deletion;
- `src/main/agent/ThreadService.ts` for canonical Agent Core responses, the
  bounded Item-argument read route, and rejection of raw tool-argument context
  reads;
- one new main-process Agent renderer-projection module and `src/main/main.ts`
  for the exhaustive response/notification envelopes and the only two IPC
  crossings, both backed by the same recursive canonical Item projector;
- `src/main/agent/capabilities/agentLocalTools.ts` for the public parameter,
  Bash `/stdin` large-text registration, byte admission, foreground writer, and
  background rejection;
- `src/main/agent/capabilities/agentCapabilities.ts` for the explicit readonly
  `StdinConsumerContract` registry and single parsed command/action/consumer
  classification;
- `src/main/agent/capabilities/subagentToolPolicy.ts` and
  `src/main/agent/runtime/ToolRuntime.ts` for consuming that same classification
  at constrained execution;
- `src/preload/index.ts`, `src/renderer/api/client.ts`, and
  `src/renderer/api/types.ts` for exposing and decoding only renderer projection
  contracts across the bridge;
- one renderer-local Agent projection type barrel plus the existing Agent files
  whose signatures consume full Thread, Turn, or Item records for replacing
  canonical type imports with renderer projection types only; behavioral edits
  are limited to `src/renderer/agent/store/threadStore.ts` and the payload-detail
  identity helper in
  `src/renderer/agent/components/items/ThreadItemView.tsx`, plus the storage-kind
  branch used by Turn copy in `src/renderer/agent/components/ThreadView.tsx`.
  They consume and cache the already-bounded Item-bound projection while
  preserving exact inline arguments, copy results, visual behavior, and the
  document renderer. The type-only work queue is derived from repository imports
  of canonical full-record types and is complete only when that renderer search
  is empty;
- `docs/spec/agent-core.md`, `docs/spec/agent-integration.md`,
  `docs/spec/agent-tool-design.md`, `docs/spec/agent-tool-permissions.md`, and
  `docs/spec/agent-thread-rendering.md` for canonical argument ownership,
  dependency/presentation boundaries, inline-versus-Item-bound rendering and
  copy behavior, stdin classification, and current behavior;
- `tests/core/agentLocalTools.test.ts`,
  `tests/core/agentCapabilities.test.ts`,
  `tests/core/agentSubagentToolPolicy.test.ts`, and one focused existing
  ToolRuntime/Thread integration test file for generic two-binding admission and
  the harmless injected data-consumer composition boundary;
- `tests/core/agentToolPayloadStore.test.ts`, one focused
  `tests/core/agentLargeTextArguments.test.ts`, and the focused Core codec/history,
  context-dependency, ContextProjector/compaction, ThreadService,
  transcript/trajectory, fork, and canonical-to-renderer projection tests that
  prove plural structural-path validation, exact rehydration, dependency-set and
  lifecycle settlement, bounded multi-binding presentation, exhaustive transport
  coverage, and rejection of private fields by renderer codecs;
- `tests/renderer/threadStore.test.ts`,
  `tests/renderer/threadItemView.test.tsx`, and
  `tests/renderer/threadToolCopy.test.ts` for Item-bound identity,
  bounded-before-IPC argument detail, cache, disclosure, and copy behavior; and
- `tests/core/agentToolCatalogStability.test.ts` and
  `tests/fixtures/__snapshots__/agentToolCatalogStability.test.ts.snap` for the
  intentional public Bash schema addition.

This feature does not modify `src/core/agent/tools.ts`, Core document protocol,
file tools, `src/outline/**`, any built-in Skill, a production Outline
schema/capacity/end-to-end fixture, Agent visual behavior, document renderer
code, dependency manifests, workflows,
`docs/TASKS.md`, or `CHANGELOG.md`. The named Core Agent protocol, codec,
history, dependency, payload-store, lifecycle, renderer transport/projection,
spec, and schema-snapshot files are the complete intentional expansion from the
previous draft. If a new action kind, public capability protocol, generic result
projection beyond the Agent renderer seam, larger context budget,
ContentStore/file-resource integration, or broader process abstraction proves
necessary, stop and return that interface decision to PM review instead of
widening this PR.

## Open questions

There are no unresolved product questions. Ratification accepts a generic,
tool-owned, plural RFC 6901 binding contract with shared count/byte ceilings;
Thread-internal exact-text dependencies; an unchanged 16 MiB skeleton-envelope
budget; exact or redacted canonical replay; reference-free renderer Item
projections; and bounded multi-binding main-process presentation. It also accepts
Bash `/stdin` as the first registered path with a 64 MiB raw UTF-8 bound and
standalone secret-history scanning, the data-driven four-state stdin-consumer
registry with the initial three Outline entries, constrained-policy failure,
Full Access behavior, and foreground-only delivery. Exact private helper names
and the focused integration test file are reversible implementation details
selected from the rebased tree.

## Acceptance criteria

### Transport And Settlement

- [ ] **AC-1:** Bash schema and canonical history expose optional
  `stdin: string`; calls that omit it retain byte-for-byte current execution and
  stored argument behavior.
- [ ] **AC-2:** A production-composition synthetic tool selects at least two
  non-overlapping nested string paths containing NUL, backslash, multiline,
  Unicode, and delimiter-heavy values whose escaped argument JSON would exceed
  16 MiB while their aggregate raw UTF-8 remains within the tool contract. The
  call factors into plural verified internal-text dependencies and a skeleton
  below 16 MiB, reconstructs the exact logical arguments, and executes once. The
  complete bound text has no duplicate copy in the context envelope, tool output,
  resource graph, or workspace. A
  second fixture proves two paths with identical bytes reuse one physical
  content-addressed value while still counting both logical values for admission.
  A payload-backed tool without a large-text contract uses an empty binding array
  and retains exact replay and current observable behavior.
- [ ] **AC-3:** Empty input, quotes, multiline text, backticks, literal `$()`
  expressions, Unicode, NUL, and candidate heredoc delimiters arrive with the
  exact UTF-8 bytes and execute no payload content as shell syntax. Unpaired
  surrogates fail before persistence or spawn rather than changing on UTF-8
  round-trip. In a payload-backed fixture, a private key and token inside stdin
  reach the child unchanged and do not change consumer classification, while
  durable internal text and history contain only the redacted value and record
  `/stdin` redaction evidence.
- [ ] **AC-4:** Complete write, forced backpressure, early child exit, stdin
  error, abort, and timeout each settle once, close or stop the writer, leave no
  unhandled stream error, and preserve native exit/interruption evidence.
- [ ] **AC-5:** Oversized raw Bash stdin, non-string stdin, and
  `stdin + run_in_background` fail before spawn; a stdin-bearing foreground call
  never auto-backgrounds. Raw stdin of 64 MiB is accepted and 64 MiB plus one
  byte is rejected independently of JSON escaping, while every context payload
  still fails at 16 MiB plus one byte.

### Classification And Authority

- [ ] **AC-6:** One shared classifier returns `absent`, `registered-data`,
  `executable`, or `unknown` from command structure and stdin presence without
  reading stdin text; capability and constrained execution consume the same
  result.
- [ ] **AC-7:** Direct `outline add --input -`, `outline commit --input -`, and
  `outline diff --input -` calls with supported global options preserve the
  capability registry's exact `outline.edit`, `outline.edit`, and
  `outline.read` actions under adversarial document payloads.
- [ ] **AC-8:** Shell `-s`, Python `-` and no-script forms, and equivalent
  supported interpreter forms classify as executable stdin and include
  `shell.local_code_execution`; wrappers, compound commands, duplicate input
  selectors, `show --selector -`, `show --projection -`, `apply --input -`,
  another unregistered `--input -` command, and `asset ingest -` cannot classify
  as registered data. Positive and adversarial tests cover each registered and
  explicitly excluded form.
- [ ] **AC-9:** Worktree, read-only, Plan, and Explore policy tests reject every
  executable and unknown stdin case before spawn while preserving an allowed
  direct registered `diff` read and rejecting direct registered `add` and
  `commit` mutations.
- [ ] **AC-10:** User-block tests prove `Action(outline.edit)`,
  `Action(shell.local_code_execution)`, `Action(shell.unknown)`, and normalized
  `Command(...)` decisions remain unavailable before spawn for their matching
  stdin calls; stdin text cannot change the match.
- [ ] **AC-11:** A Full Access root call with no matching block can execute one
  registered-data, executable, or unknown stdin consumer once, and its audit
  evidence reports command and consumer class without payload contents.

### Repository Gates

- [ ] **AC-12:** Production-composition tests cross canonical argument admission,
  tool-owned multi-binding selection, internal-text publication, Item dependency
  settlement, capability evaluation, constrained policy, execution, and final
  settlement rather than reconstructing those boundaries in a helper. Separate
  tests reject non-canonical, duplicate, overlapping, reordered, non-string,
  excessive-count, excessive-byte, undeclared, extra, and skeleton-mismatched
  paths or references. Lifecycle tests cover interruption after each text
  publication, context publication, and Item commit; fork/copy; child
  inheritance; Retry; rollback; pruning; deletion; startup orphan reconciliation;
  missing/corrupt text; shared references; and redacted replay.

  A two-binding worst-case escaping fixture proves exact Provider replay while
  renderer detail, Turn copy, transcript, trajectory, and compaction share one
  global 32,000-character result bound without moving binding metadata or
  complete payload-backed bound text across IPC and without whole-value
  stringification. A maximum admitted Bash stdin fixture proves the same generic
  path and exact child bytes. One admitted inline Bash `stdin` fixture remains
  complete in renderer projection, disclosure, and Turn copy. The existing
  generic inline fixture whose pretty-printed 8,000-element array exceeds 32,768
  characters also remains complete across those paths. Canonical-to-renderer
  fixtures containing multiple private internal-text dependencies prove every
  paged Thread/Turn/Item read, every Thread- or Turn-returning
  start/resume/fork/rollback/retry/configuration/detail response, and every full
  Thread/Turn/Item live notification returns the same Item-bound stub. Deep scans
  of every projected envelope prove that neither the context reference from
  canonical model-call arguments nor any binding path/internal-text reference
  crosses IPC. Renderer codecs reject every private field, and an exhaustiveness
  guard fails when a new response method or notification can carry canonical
  Items without a projection case.
- [ ] **AC-13:** Focused `agentLocalTools`, `agentCapabilities`,
  `agentSubagentToolPolicy`, `agentToolPayloadStore`, Core codec/history and
  large-text contract/path, context-dependency, Thread lifecycle/projection,
  renderer transport, `threadStore`, Item-bound detail identity, Item-bound Turn
  copy, preserved complete-inline Bash stdin and generic disclosure/copy,
  catalog-stability, and ToolRuntime/Thread integration tests pass.
- [ ] **AC-14:** `bun run typecheck`, `bun run test:core`,
  `bun run test:renderer`, `bun run docs:check`, and `git diff --check` pass.
- [ ] **AC-15:** An executable diff allow-list proves the PR changes only the
  named Core Agent protocol/codec/history/dependency and generic large-text
  contract owners; Bash/capability/policy/runtime files; Thread
  payload/lifecycle/projection owners; the main/preload Agent renderer seam;
  renderer API/projection type consumers; store, Item-bound identity, and
  Turn-copy adapters; five named specs; focused generic/Bash tests; and the Bash
  schema snapshot above. It contains no `src/outline/**`, built-in Skill,
  production Outline schema/capacity/end-to-end fixture, file-tool, ContentStore,
  Agent visual-behavior, document renderer, Core document protocol or action-kind,
  dependency, workflow, board, or changelog change.
