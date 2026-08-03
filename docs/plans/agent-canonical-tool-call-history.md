# Canonical Tool-Call History

## Goal and purpose

Ship one complete Agent Core feature in one implementation PR: make the exact
admitted, model-visible tool call the sole authority for tool history. Every
later provider request must either replay that schema-valid call or emit typed,
redacted evidence explaining why it cannot be replayed. Presentation Items and
host execution metadata must never be used to invent model arguments.

This fixes the repeated tool failures observed during a packaged Tenon browser
task without weakening tool schemas or changing the Full Access permission
model. It also closes the same latent defect for file, collaboration, MCP, and
dynamic tools rather than special-casing `bash`.

## Non-goals

- Do not allow unknown tool arguments, add `cwd` to the `bash` schema, or relax
  `additionalProperties: false`.
- Do not add a permission prompt, approval mode, filesystem sandbox, or new
  capability policy. A valid exposed tool remains authorized under the existing
  Full Access boundary unless an explicit capability block applies.
- Do not revive the superseded Tenon-native Browser Pilot integration or change
  the shipped `browser-pilot` managed Skill/catalog path. Browser Pilot already
  runs through the generic `bash` contract and is an acceptance case for this
  Core fix, not a separate implementation surface.
- Do not redesign tool rows, result envelopes, output compaction, or the tool
  catalog. Renderer changes are limited to sourcing arguments from the new
  canonical record and keeping host metadata visually distinct.
- Do not migrate or reconstruct old Thread data. This is a pre-release format
  change: isolated dev `userData` is reset and the old reverse-mapping reader is
  deleted.

## Background

### Incident evidence

Diagnostics from the packaged task showed 80 `bash` attempts. Sixty-four were
rejected before execution because their arguments contained `cwd`; sixteen
reached the shell, fifteen succeeded, and the only non-zero execution was the
first attempt before `bp` was installed. The Turn eventually completed, but the
rejection loop consumed time, context, and approximately $2.17.

The same diagnostic bundle recorded both sides of the contradiction:

- the exposed `bash` schema accepted only `command`, `description`, `timeout`,
  and `run_in_background`;
- canonical provider history repeatedly contained `{ command, cwd }`.

This was not a capability or operating-system denial. Schema admission failed
inside the native kernel before `ToolRuntime` could evaluate the capability or
execute the command. Full Access grants authority to execute a valid exposed
operation; it does not make malformed model-tool calls valid.

Browser Pilot does not have a Tenon-native runtime or host-injected client key.
It already reaches users as a managed Skill and drives `bp` through ordinary
`bash` command text. Secret-like values can therefore be model-authored
arguments inside a successful call. Canonical history must preserve the
successful call/result relationship while redacting those values; dropping the
whole call would create a second retry loop.

### Causal chain

1. A valid `bash` call is admitted with model arguments such as `command` and
   `description`; its Item carries the Thread working directory used by the
   host.
2. `ContextProjector.historyToolArguments()` reverse-engineers a supposed model
   call as `{ command, cwd }`, adding an invalid argument while dropping the
   valid `description` argument.
3. `PiTurnExecutor.transformContext` submits that invented call before the next
   model response. The model treats it as a few-shot example and emits `cwd`.
4. The kernel emits `tool_execution_start` with the raw model arguments before
   `prepareToolCall` validates them. `PiEventNormalizer` therefore creates an
   Item before admission finishes.
5. Item creation gives raw `input.cwd` precedence over `context.thread.cwd`, so
   the rejected model value is persisted as if it were the effective execution
   directory. The schema then correctly rejects the call before execution.
6. The reverse mapper replays that rejected value byte-for-byte, and the model
   emits it again. The Item is therefore both a false audit record and a
   self-reinforcing invalid example.

The `bash` symptom exposes a general category error. A `ThreadItem` is an audit
and presentation projection of an execution, not a lossless source call:

- `fileChange` is mapped back to `file_write`, `file_edit`, or `file_delete`
  from its resulting change kinds and is given a fabricated `{ changes }`
  argument that no file-tool schema accepts;
- collaboration Items retain only a display-oriented subset of inputs, so they
  cannot reconstruct `target`, `task_name`, `fork_turns`, or other tool-specific
  arguments reliably;
- MCP and dynamic Items retain bounded JSON, which may cease to be the exact
  schema-valid value after truncation;
- a renamed, removed, disabled, or schema-changed tool can make an otherwise
  honest historical call invalid under the active registry.

The current test suite encodes the defect by expecting the synthetic
`{ command, cwd }` history shape. Fixing only that expectation would leave the
underlying two-authority model intact.

### Options considered

1. **Minimum patch: widen `bash` or remove only `cwd`.** This stops one symptom
   but either turns host state into model input or leaves every other reverse
   mapper able to drift. Rejected.
2. **Brownfield patch: maintain a per-Item argument reconstructor.** This keeps
   presentation Items as a second protocol authority and requires every future
   tool/schema change to update an unrelated history mapper. Rejected.
3. **Clean-slate invocation aggregate.** Replace all specialized tool Items and
   renderer projections with one new invocation object. This gives a sound
   authority but needlessly rewrites established audit, output, and UI behavior.
   Rejected for blast radius.
4. **Canonical call envelope attached to existing tool Items.** Persist the
   admitted call once, retain existing Item variants as execution/display
   projections, and make history consume only the envelope. This is selected:
   it removes the second authority while preserving the useful brownfield
   surfaces.

## Design

### Decision summary

- **DEC-01:** Attach one immutable model-call envelope to every existing tool
  Item; keep the specialized Item fields as execution and presentation data.
- **DEC-02:** Introduce one kernel admission event for every raw call. It carries
  either a replayable canonical call or redacted rejection evidence;
  execution-start events occur only for admitted calls.
- **DEC-03:** Replay only envelope arguments that validate against the active
  registry. All other history becomes typed evidence, never a fabricated call.
- **DEC-04:** Keep schemas strict and capability evaluation after schema
  admission. The existing managed Browser Pilot path remains unchanged and
  exercises the generic `bash` behavior.

### One authority, three data layers

Every tool Item gains a `modelCall` envelope. The exact names are implementation
details, but the protocol shape must preserve this distinction:

```ts
type ModelToolCallHistory =
  | {
      disposition: 'replayable';
      identity: ModelToolIdentity;
      arguments: InlineJsonArguments | ThreadOwnedArgumentsReference;
      schemaDigest: string;
    }
  | {
      disposition: 'redactedReplay';
      identity: ModelToolIdentity;
      redactedArguments: InlineJsonArguments | ThreadOwnedArgumentsReference;
      redactedPaths: readonly JsonPointer[];
      schemaDigest: string;
    }
  | {
      disposition: 'evidenceOnly';
      identity: ModelToolIdentity | null;
      providerName: string;
      redactedArgumentsSummary: JsonValue | string;
      reason: ToolCallEvidenceReason;
      correction: string;
    };
```

The Item ID remains the tool-call ID. A replayable identity is canonical
`namespace + name`, not a provider's flattened spelling; projection encodes it
for the active provider registry.

The three layers have separate owners:

| Layer | Contains | May enter provider history |
| --- | --- | --- |
| Canonical model call | resolved identity, exact admitted model arguments, schema digest | yes, after replay validation |
| Host execution context | Thread `cwd`, workspace/scratch roots, process policy, environment, private handles and credentials | never |
| Item presentation/audit | command label, file changes, process ID, duration, result/output references, capability audit | result projection only; never a source of call arguments |

Non-secret host facts such as the effective `cwd` may remain on an Item for
audit and display. `commandExecution.cwd` is always resolved from the host
Thread execution context, including for a rejected call; raw model input can
never override it. These facts are still not model arguments. Secret host
values are transient and must not enter Items, argument payloads, transcript
artifacts, rollout records, or diagnostics.

### FLOW-01: Admission, execution, and replay

The runtime uses one explicit sequence:

```text
raw provider tool call
  -> resolve canonical identity in the active registry
  -> run model-argument preparation/normalization
  -> validate against the exposed schema
  -> create and persist ModelToolCallHistory
  -> evaluate capability blocks from the validated arguments
  -> bind host execution context
  -> execute and persist result/presentation fields
```

`prepareArguments` may normalize provider/model syntax, but it may not inject
host metadata. Any future execution preparation that supplies environment,
credentials, or app-owned paths occurs after the canonical call is frozen and
through a host-only runtime closure or execution context.

The kernel emits a dedicated admission event for every raw call after preparing
the durable envelope. Execution-start follows only for admitted calls. A
rejected admission is completed directly from its evidence record, so no
consumer can mistake raw, unvalidated provider arguments for an admitted call.
Capability evaluation receives the validated arguments and therefore remains a
separate later gate:

- an unknown tool, malformed arguments, or a truncated call is an admission
  rejection and has no capability decision;
- an admitted call blocked by policy is a normal tool call with a structured
  `operation_unavailable` result and capability audit;
- an admitted Full Access call reaches its tool and records native host/service
  success or failure.

### Successful and failed admitted calls

Schema-valid calls receive a replayable envelope before execution. The envelope
survives tool success, capability unavailability, command failure, cancellation,
restart, fork, and compaction. The result may change the Item's status and
presentation fields but never rewrites the call.

An admitted call whose arguments contain secret-like values receives a
`redactedReplay` envelope instead. The ephemeral validated arguments still reach
execution, while only structure-preserving redacted arguments and JSON-pointer
redaction locations become durable. When those redacted arguments remain valid
under the active schema, provider history emits an atomic three-part unit:

1. typed host evidence stating that listed historical argument paths were
   redacted after execution and must not trigger a retry;
2. the call with redacted arguments;
3. its original projected result.

The marker makes clear that the displayed value is not the literal executed
value. If redaction makes the arguments schema-invalid, projection emits one
typed executed-call evidence unit containing the redacted structure and outcome
instead. In both cases the model sees that the operation ran and what happened;
the raw secret is never persisted or replayed.

Provider history emits the stored call and its projected result as one atomic
unit. `ContextProjector` must not consult Item-type-specific reverse mappings.
`historyToolArguments()` and `historyToolIdentity()` are deleted, and no
replacement is allowed to derive arguments from `command`, `cwd`, `changes`,
collaboration display fields, or results.

The live no-`transformContext` kernel path and the canonical projector path use
the same admission outcome. After a response is admitted, the kernel's next
in-memory provider context is rebuilt or sanitized from replayable envelopes;
it does not retain a raw invalid assistant tool-call part as hidden history.

### Rejected calls and failure recovery

A pre-execution rejection still produces a failed existing tool Item so the
user can inspect what happened, but its `modelCall` disposition is
`evidenceOnly`. It stores only a bounded, secret-redacted argument summary, a
stable reason code, and actionable correction text. Reasons cover at least:

- unresolved/disabled tool identity;
- invalid arguments;
- provider-truncated arguments;
- unresolved argument persistence failures.

On the next request, typed correction evidence replaces the rejected call. The
projector never emits the invalid tool call, never emits an orphaned tool
result, and never fabricates corrected arguments. Mixed batches keep every
admitted call/result pair intact and append rejection evidence in original call
order.

Model-supplied arguments pass the existing secret-like key/value redaction
policy before persistence. Admitted calls whose values change use
`redactedReplay`; rejected calls retain only evidence. Host-injected secrets
remain outside model calls, while shell commands and other free-form model
arguments are explicitly treated as possible secret carriers.

### Argument storage and lifecycle

Small ordinary JSON arguments stay inline. Arguments above the inline bound use
a content-addressed, Thread-owned JSON payload with an exact codec and digest;
they are not truncated into a different value. The reference participates in
the same dependency enumeration, fork copy, deletion, and integrity checks as
other Thread-owned context resources.

Before every provider submission, replay resolves the current canonical tool
registry and preflights the entire call/result unit. It validates loaded
arguments against the current schema and resolves every result dependency,
including full-output and image payload references. The stored schema digest
provides diagnostics, not permission to bypass the current contract. If the
tool is absent, its schema changed incompatibly, or any argument/result payload
is missing or corrupt, projection records a bounded diagnostic and degrades the
whole pair to typed evidence. Available Item output and resource identity become
the bounded fallback; the evidence names anything unavailable. Projection must
not throw on the user path, emit an orphan, or send known-invalid history.

This validation is a final invariant check, not a second source of arguments.
The normal successful path round-trips the same admitted JSON value byte-for-byte
after canonical JSON encoding.

### Presentation, transcript, diagnostics, and memory

Existing specialized Items remain the source for readable rows and execution
facts. Surfaces that label data as tool arguments use the canonical envelope;
the host-resolved `cwd` and similar values are shown only as execution context.
Transcript export uses exact arguments, marked redacted arguments, or the
evidence-only redacted summary, never an Item reverse mapper.

Diagnostics record admission phase, canonical identity, schema digest,
replay/evidence disposition, and bounded redacted validation errors. They never
capture raw secret-bearing values or host-only environment. Memory extraction
may summarize completed outcomes but cannot reconstruct calls from presentation
fields.

Compaction treats a replayable call/result as an indivisible unit and treats
rejection evidence as an ordinary typed evidence unit. Restart, fork, current
Turn tool loops, retry, and post-compaction projection must therefore make the
same replay decision from the same persisted facts.

### Current, changed, and preserved behavior

| Concern | Current | After this change | Preserved |
| --- | --- | --- | --- |
| `bash` history | adds `cwd` and drops valid arguments such as `description` | replays all admitted model arguments and no invented fields | shell runs in the Thread `cwd` with host-account authority |
| File history | infers a tool and fabricates `{ changes }` | replays the original file tool and arguments | file-change rows and result evidence |
| Invalid call | failed Item is replayed as another invalid call | redacted correction evidence, never a tool call | visible failure and model opportunity to recover |
| Permission | schema rejection can look like denial | admission and capability phases are explicit | Full Access plus explicit capability blocks |
| Host metadata | rejected model `cwd` can overwrite the audit value and re-enter arguments | host-resolved only, bound at execution and displayed as metadata | workspace, process, and audit behavior |
| Secret-like model argument | entire admitted call can disappear after redaction | marked redacted call/result replay or executed-call evidence | no durable or replayed raw secret |
| Schema/tool/resource drift | stale arguments or missing result payloads can throw | pair-level preflight and typed evidence degradation | immutable source Item and diagnostics |

### Implementation scope

Expected production ownership:

- `src/core/agent/protocol.ts` and `src/core/agent/codec.ts`: exact envelope,
  payload-reference, and evidence-reason contracts.
- `src/core/agent/tools.ts`: deterministic schema digest and active-registry
  lookup/validation helpers if they do not belong beside the runtime registry.
- `src/main/agent/runtime/kernel/{types,kernel}.ts`: admission outcome, event
  ordering, and sanitized live history.
- `src/main/agent/runtime/{ToolRuntime,PiTurnExecutor}.ts`: capability/host seam,
  canonical Item capture, rejection completion, payload persistence, and
  retirement of raw `input.cwd` precedence in `startedToolItem`; command Items
  take `cwd` only from the host Thread execution context.
- `src/main/agent/context/{ContextProjector,contextDependencies,ContextCompaction}.ts`:
  envelope-only replay, final registry validation, graceful evidence fallback,
  and payload lifecycle.
- `src/main/agent/thread/TranscriptRenderer.ts` and
  `src/main/agent/extensions/memory/Phase1.ts`: consume canonical/evidence
  arguments without reverse reconstruction.
- Renderer argument/detail selectors only where they currently label host
  metadata as model arguments.
- `docs/spec/agent-core.md`, `docs/spec/agent-model-runtime.md`,
  `docs/spec/agent-tool-design.md`, `docs/spec/agent-tool-permissions.md`, and
  `docs/spec/agent-thread-rendering.md`: fold in the shipped contract.
- Focused Core, renderer-selector, codec, persistence, context, transcript, and
  native-kernel tests.

No `src/core/commands.ts`, `src/core/types.ts`, dependency, build configuration,
`docs/TASKS.md`, or `CHANGELOG.md` change belongs to the dev implementation PR.
Main owns board/changelog updates at merge.

### Requirements and acceptance criteria

- **NFR-01:** Durable and diagnostic tool history contains neither host-only
  execution secrets nor unredacted secret-like model arguments.
- **AC-01:** A `bash` call containing only `command` and `description` survives
  execute -> persist -> codec decode -> restart/fork -> provider projection with
  exactly those arguments; `cwd` remains host/display metadata and is absent.
- **AC-02:** A `bash` call containing `cwd` is rejected once, is labeled argument
  validation rather than permission denial, and becomes correction evidence on
  the next provider request. It is never replayed as a tool call.
- **AC-03:** Representative calls for every enabled tool family -- local read/write,
  outline, control, collaboration, web, Skills, MCP, and dynamic/plugin tools --
  round-trip through persistence and validate against the active registry with
  deep-equal canonical arguments.
- **AC-04:** File mutations replay `file_path`, content/edit parameters, and flags from the
  admitted call; no projected call contains a synthetic `changes` property.
- **AC-05:** Schema-valid capability-blocked calls retain their call/result pair and audit;
  schema-invalid calls produce no capability decision.
- **AC-06:** Missing tools, incompatible current schemas, and missing/corrupt
  argument, full-output, or image payloads produce diagnostics plus typed
  pair-level evidence without throwing, orphaning a tool result, or
  contaminating later requests.
- **AC-07:** Large arguments remain exact through Thread-owned payload storage and fork;
  no bounded/truncated value is presented as the original call.
- **AC-08:** An admitted call with secret-like model arguments persists as
  `redactedReplay`: the model sees marked redacted arguments and the original
  outcome, never receives a retry-inducing rejection merely because redaction
  occurred, and never sees the raw secret. If redaction breaks the active
  schema, typed executed-call evidence preserves the same facts. Host
  credentials/environment are absent from Items, payloads, transcript exports,
  provider diagnostics, and rollout diagnostics.
- **AC-09:** Mixed parallel/sequential tool batches preserve order, keep admitted
  call/result pairs atomic, and place rejection evidence deterministically.
- **AC-10:** `rg "historyToolArguments|historyToolIdentity" src tests` is empty, and tests
  prevent new Item-to-argument reverse mappers.
- **AC-11:** `bun run typecheck`, `bun run test:core`, `bun run test:renderer`, and
  `bun run docs:check` pass after the implementation and spec fold-in.
- **AC-12:** For both admitted and rejected `bash` calls, the Item and UI `cwd`
  equal the host-resolved Thread execution directory and never a model-supplied
  `cwd` value.
- **AC-13:** A managed `browser-pilot` `bash` call containing a secret-like
  client value executes once; the next provider context contains its marked
  redacted call and success result, not an erased call or an admission-rejection
  retry signal.

### Risks and mitigations

- **Protocol blast radius.** Every tool Item crosses codec, persistence,
  renderer, transcript, memory, fork, and compaction paths. Exact codecs and an
  exhaustive all-tool-family round-trip matrix make omissions fail locally.
- **Payload retention leaks.** New argument references must join existing
  dependency enumeration and deletion/fork tests before any large argument can
  use them.
- **Secret persistence and replay truth.** Redaction occurs before durable
  admission. `redactedReplay` stores paths plus redacted structure, and its
  atomic marker states that the visible value is not the executed value; no raw
  secret or misleading unmarked call can enter history.
- **Provider/tool evolution.** Canonical identity plus current-registry
  validation prevents stale provider spellings or schema digests from becoming
  execution authority.
- **Runtime regression from event reordering.** Golden kernel tests cover
  success, validation rejection, truncated calls, cancellation, mixed batches,
  retry, and no-`transformContext` memory mode.
- **Context growth.** Large values stay out of Items, while replayable pairs and
  evidence use existing budget/compaction units and bounded summaries.

## Open questions

None. Tool schemas remain strict, and no Item-to-argument reverse mapper is
permitted. The shipped managed Browser Pilot path is covered through the generic
`bash` contract; the superseded Tenon-native plan is not revived.
