# Agent Bash Stdin Transport

## Goal

Give the existing `bash` tool one bounded, durable, literal stdin channel so a
model can pass structured text to a CLI without placing data in shell grammar,
process arguments, the environment, or a temporary file. The immediate consumer
is the public `outline add|commit|diff --input -` workflow, but the transport,
durable argument representation, and security classification belong to the
generic Agent boundary.

This plan is shape **(a): one complete feature in one PR**. The public tool
field, canonical admission, effective-consumer classification, foreground
stream lifecycle, constrained-Agent policy, history behavior, current-behavior
specification, and focused tests ship together. The feature is independently
useful and verifiable before any Outline CLI or Skill optimization consumes it.

The objectives are:

- **OBJ-1:** Carry structured UTF-8 input beyond the operating system's argv
  limit without quoting, delimiter, expansion, or injection ambiguity.
- **OBJ-2:** Preserve the worktree, read-only, Plan, Explore, and explicit user
  block boundaries when stdin is data, executable source, or an unknown input
  contract.
- **OBJ-3:** Preserve existing Bash behavior exactly when `stdin` is omitted and
  preserve one canonical settlement when input delivery succeeds, fails, or is
  interrupted.

## Non-goals

- Do not change the Outline CLI, Outline contract, built-in Outline Skill,
  Runtime, document storage, renderer, or Core document protocol. The separate
  `outline-cli-skill-efficiency` feature consumes this interface after merge.
- Do not raise the 16 MiB Thread context-payload budget. Large stdin uses one
  typed internal-text dependency instead of making any JSON context envelope
  absorb nested escaping overhead.
- Do not turn stdin into an Agent file resource, ContentStore revision, source,
  workspace file, or public digest-bearing handle. Internal argument text stays
  under the existing Thread payload lifecycle and is not addressable by the
  model or a file tool.
- Do not add or invoke a file tool, temporary input artifact, named pipe, helper
  executable, environment variable, or shell heredoc as transport.
- Do not parse, scan, classify, redact, summarize, or authorize from the stdin
  payload's program or document text. Authority derives from the parsed command,
  the effective stdin consumer, and existing policy.
- Do not add a new action kind or broaden `shell.local_code_execution` in
  worktrees. Ordinary worktree project scripts and local code execution without
  stdin preserve their current behavior.
- Do not add binary stdin in this feature. The public field is a JSON string and
  its child representation is the exact UTF-8 encoding of that string.
- Do not add background stdin. Explicit background input is rejected before
  spawn, and a foreground stdin call cannot auto-background.
- Do not change the generic Bash output projection, artifact retention,
  capability-block syntax, confirmation model, or retry policy.
- Do not add migration, compatibility, or legacy tool-call readers. The optional
  field and internal representation extend the current pre-release schema;
  clean-reset verification replaces old readers.

## Design

### 1. Decision Summary And Existing Boundary

Current Bash accepts `command`, `description`, `timeout`, and
`run_in_background`; both foreground and background spawns ignore child stdin.
Consequently a call such as `outline --human add --input -` can receive data
only when the model embeds it in `zsh -c` through quoting or a heredoc. On the
supported macOS host, that path fails with `E2BIG` before the CLI starts when
the shell argument reaches the operating-system limit. A heredoc also needs a
delimiter proven absent from arbitrary user content.

The accepted public call is instead:

```json
{
  "command": "outline --human add --input -",
  "stdin": "{\"placement\":{...},\"nodes\":[...]}"
}
```

`command` remains the complete executable authority. `stdin` is one literal
string delivered to that process after admission. No newline, terminator,
quoting layer, or other byte is added.

### 2. Public Tool Requirements And Admission Contract

- **FR-1:** `BASH_PARAMETERS` and `BashParams` expose optional
  `stdin: string`. Admission rejects non-strings, more than 64 MiB of UTF-8, and
  strings containing unpaired UTF-16 surrogates before persistence or spawn.
  The well-formed-Unicode rule makes the admitted string exactly recoverable
  from its UTF-8 bytes instead of silently replacing isolated surrogates.
- **FR-2:** The admitted UTF-8 bytes are exactly `Buffer.from(stdin, 'utf8')`.
  Empty input is distinct from omitted input; line endings and Unicode are not
  normalized.
- **FR-3:** Bash admission measures the raw UTF-8 stdin bytes independently of
  JSON serialization and accepts up to 64 MiB. This covers every registered
  Outline stdin artifact within the current Runtime request/upload authority
  without promising that a later CLI normalization cannot produce its own
  typed size rejection. A schema-valid two-node add fixture containing two
  4,194,304-code-unit NUL values is 50,331,901 raw bytes and must be admitted;
  its roughly 58.7 MiB nested argument JSON is evidence that serialized size is
  not the transport authority.
- **FR-4:** Exact arguments up to the existing 32 KiB inline threshold keep the
  current representation. For a payload-backed Bash call with stdin, canonical
  admission stores the durable stdin value once as content-addressed UTF-8 under
  a new private `ThreadInternalTextPayloadReference`. The bounded
  `toolCallArguments` context payload stores the remaining JSON object plus one
  typed top-level `stdin` binding to that reference; it never stores a sentinel
  inside user JSON. The `ModelToolCallArguments` payload form declares the same
  internal-text dependency on its owning Tool Item. Publication writes and
  verifies internal text first, then the context envelope, then commits the
  owning Item. An interrupted admission may leave reclaimable unowned payloads
  but cannot commit an Item whose declared dependency was never published. All
  context payloads retain the existing 16 MiB limit.
- **FR-5:** History, main-process transcript and trajectory projection, Turn
  replay, fork, Retry, rollback, deletion, pruning, and child inheritance
  resolve or copy the argument context and its declared internal-text dependency
  as one logical unit. Resolution verifies digest, byte length, strict UTF-8,
  binding uniqueness, an object skeleton, declaration of every bound reference,
  and absence of the bound field before reconstructing the exact logical
  arguments. JSON object key order is not identity; the reconstructed `JsonValue`
  must be logically exact. A missing or corrupt dependency yields the existing
  typed unavailable/evidence behavior and never a partial argument object.
  Existing structural secret redaction remains authoritative: replayable calls
  may stream the retained exact text, while redacted-replay calls retain only
  redacted durable text and use the transient admitted source for that one live
  execution. Bash adds no duplicate log, output echo, command summary,
  environment copy, or temporary input file.

The private representation has one narrow shape. A
`ThreadInternalTextPayloadReference` carries only a content digest, byte length,
and fixed UTF-8 encoding. A stored tool-argument envelope carries a JSON object
skeleton and at most one `{ field: 'stdin', ref }` binding outside that object.
The payload-backed `ModelToolCallArguments` carries the context reference plus
the same declared internal-text reference, making the Tool Item the retention
owner. The new reference is not a `ThreadItemOutputReference`, does not carry a
presentation summary or filename, and is unavailable through output, resource,
file-tool, or model-facing read APIs. The raw storage envelope remains private;
history and detail readers receive either the rehydrated logical arguments or
typed unavailability, never the binding metadata. Existing Thread-private
publication mechanics may be shared, but input text and tool output remain
distinct semantic types.

This is a storage representation split, not a larger generic JSON payload. It
does not modify any downstream CLI schema, expose a second model-facing input,
or route the workflow through file tools.

### 3. One Effective-consumer Classification

Adding stdin changes the meaning of some commands without changing their argv.
`outline ... --input -` consumes stdin as data, while `bash -s`, `sh -s`,
`python -`, and similar interpreter forms consume stdin as executable source.
An arbitrary executable may do either. Permission and constrained-Agent policy
therefore cannot use an absolute command-only rule.

One shared production classifier parses the command once and returns both the
existing action descriptors and one private stdin-consumer fact:

| Consumer | Meaning | Classification |
| --- | --- | --- |
| `absent` | `stdin` was omitted | Existing command classification, unchanged |
| `registered-data` | One direct registered command explicitly selects stdin as data | Existing direct-command actions; stdin text remains opaque |
| `executable` | A known interpreter form consumes stdin as program source | Existing command actions plus `shell.local_code_execution` |
| `unknown` | Stdin is present but the direct consumer is not registered or provable | Existing command actions plus `shell.unknown` |

- **FR-6:** Registered-data recognition is fail-closed and command-shaped. It
  accepts only one direct executable invocation whose parsed argv matches a
  host-owned stdin contract. The initial registry contains exactly these forms,
  with supported Outline global options before the command and exactly one
  literal `--input -` pair:

  - `outline [GLOBAL OPTIONS] add --input -`
  - `outline [GLOBAL OPTIONS] commit --input -`
  - `outline [GLOBAL OPTIONS] diff --input -`

  Additional argv is accepted only as ordinary arguments to that same direct
  command and cannot add another input source or shell segment. Compound shell
  commands, wrappers, substitutions, pipelines, redirections, duplicate input
  selectors, and extra shell segments cannot inherit a data registration.
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

Unit tests of the writer or classifier are insufficient because the security
property exists only when provider arguments, canonical admission, capability
evaluation, subagent policy, real Bash execution, and result settlement use the
same facts. One focused integration fixture drives the real root and delegated
Bash entry points with injected external authorities but the production
composition mechanism.

The fixture proves positive and negative authority:

1. direct registered Outline-shaped data reaches a harmless capture executable
   byte-for-byte under allowed policy;
2. the same command retains its read/edit action for explicit blocks and
   worktree policy;
3. executable and unknown stdin never spawn in worktree, read-only, Plan, or
   Explore contexts; and
4. Full Access plus no matching block reaches the child once and settles once.

## Dependency And Collision Boundary

This foundation is a prerequisite of the separately planned
[`outline-cli-skill-efficiency`](https://github.com/relixiaobo/lin-outliner/pull/595)
feature. It does not depend on that feature or Source PR-I, and it modifies no
Outline path. The consumer PR rebases after this foundation merges and verifies
only the public `stdin` interface end to end. The internal-text dependency and
rehydration contract are a shared Core Agent persistence-interface change, so
this revised plan returns to PM ratification before implementation. It does not
alter the Core document protocol, an Outline schema, or the Agent file-resource
model.

The collision self-check found one open PR, `outline-cli-skill-efficiency`, whose
current plan discusses this missing interface but claims no generic Agent file.
That PR will replace its embedded foundation design with a dependency link. No
other open PR currently claims the expected files below. A fresh `gh pr list`
and actual-diff check run again immediately before implementation.

## Implementation Boundary

Expected implementation ownership:

- `src/core/agent/protocol.ts` and `src/core/agent/codec.ts` for the private
  internal-text reference, compact argument binding, declared dependency, and
  strict decode contract;
- `src/core/agent/modelCallHistory.ts`,
  `src/main/agent/runtime/toolCallHistory.ts`, and
  `src/main/agent/runtime/types.ts` for factoring, declaring dependencies, and
  rehydrating one logical argument value;
- `src/main/agent/persistence/ToolPayloadStore.ts` for content-addressed internal
  text publication, verified reads/streams, copy, pruning, and cleanup;
- `src/main/agent/context/contextDependencies.ts`, `ContextCompaction.ts`, and
  `ContextProjector.ts` for dependency verification, inherited history, and
  replay projection;
- `src/main/agent/thread/ThreadCatalogOps.ts`, `ThreadResourceOps.ts`,
  `ThreadTrajectoryProjection.ts`, `TranscriptRenderer.ts`, and
  `TurnLifecycle.ts` for Thread inventory, fork/copy, Retry/rollback,
  reader-facing projection, orphan reconciliation, and deletion;
- `src/main/agent/capabilities/agentLocalTools.ts` for the public parameter,
  byte admission, foreground writer, and background rejection;
- `src/main/agent/capabilities/agentCapabilities.ts` for the single parsed
  command/action/stdin-consumer classification;
- `src/main/agent/capabilities/subagentToolPolicy.ts` and
  `src/main/agent/runtime/ToolRuntime.ts` for consuming that same classification
  at constrained execution;
- `docs/spec/agent-tool-design.md` and
  `docs/spec/agent-integration.md` for current behavior;
- `tests/core/agentLocalTools.test.ts`,
  `tests/core/agentCapabilities.test.ts`,
  `tests/core/agentSubagentToolPolicy.test.ts`, and one focused existing
  ToolRuntime/Thread integration test file for the real composition boundary;
- `tests/core/agentToolPayloadStore.test.ts` and the focused Core codec/history,
  context-dependency, ContextProjector/compaction, ThreadService,
  transcript/trajectory, and fork tests that prove exact rehydration and
  lifecycle settlement; and
- `tests/core/agentToolCatalogStability.test.ts` and
  `tests/fixtures/__snapshots__/agentToolCatalogStability.test.ts.snap` for the
  intentional public Bash schema addition.

This feature does not modify `src/core/agent/tools.ts`, Core document protocol,
file tools, Outline code or fixtures, another built-in Skill, renderer code,
dependency manifests, workflows, `docs/TASKS.md`, or `CHANGELOG.md`. The named
Core Agent protocol, codec, history, dependency, payload-store, lifecycle, and
schema-snapshot files are the complete intentional expansion from the previous
draft. If a new action kind, public capability protocol, generic result
projection, larger context budget, ContentStore/file-resource integration, or
broader process abstraction proves necessary, stop and return that interface
decision to PM review instead of widening this PR.

## Open questions

There are no unresolved product questions. Ratification accepts the optional
well-formed-Unicode string field with a 64 MiB raw UTF-8 bound, Thread-internal
text factoring for payload-backed Bash calls, unchanged 16 MiB context-payload
budget, exact three-form Outline data registry, four-state consumer model,
constrained-policy failure, Full Access behavior, and foreground-only lifecycle
together. Exact private helper names and the focused integration test file are
reversible implementation details selected from the rebased tree.

## Acceptance criteria

### Transport And Settlement

- [ ] **AC-1:** Bash schema and canonical history expose optional
  `stdin: string`; calls that omit it retain byte-for-byte current execution and
  stored argument behavior.
- [ ] **AC-2:** A legal structured payload larger than macOS `ARG_MAX`, including
  two 4,194,304-code-unit NUL-valued Nodes, passes the production Outline add
  schema, measures 50,331,901 raw stdin bytes, factors into one verified internal
  text dependency plus a context envelope below 16 MiB, reconstructs the exact
  logical arguments, and reaches child stdin intact. Command argv, environment,
  stdout/stderr, and the child workspace contain no transport copy.
- [ ] **AC-3:** Empty input, quotes, multiline text, backticks, literal `$()`
  expressions, Unicode, NUL, and candidate heredoc delimiters arrive with the
  exact UTF-8 bytes and execute no payload content as shell syntax. Unpaired
  surrogates fail before persistence or spawn rather than changing on UTF-8
  round-trip.
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

- [ ] **AC-12:** A production-composition test crosses canonical argument
  admission, internal-text factoring, Item dependency publication, capability
  evaluation, constrained policy, verified child input, and final settlement
  rather than reconstructing those boundaries in a test helper. Separate
  lifecycle tests prove interrupted publication, fork/copy, child inheritance,
  Retry, rollback, pruning, deletion, startup orphan reconciliation, missing
  text, corrupt text, undeclared or duplicate bindings, and redacted-replay
  behavior.
- [ ] **AC-13:** Focused `agentLocalTools`, `agentCapabilities`,
  `agentSubagentToolPolicy`, `agentToolPayloadStore`, Core codec/history and
  context-dependency, Thread lifecycle, catalog-stability, and
  ToolRuntime/Thread integration tests pass.
- [ ] **AC-14:** `bun run typecheck`, `bun run test:core`, `bun run docs:check`,
  and `git diff --check` pass.
- [ ] **AC-15:** An executable diff allow-list proves the PR changes only the
  named Core Agent protocol/codec/history/dependency, generic
  Bash/capability/policy/runtime, Thread payload/lifecycle owners, specs, focused
  tests, and Bash schema snapshot above; it contains no Outline, file-tool,
  ContentStore, renderer, Core document protocol or action-kind, dependency,
  workflow, board, or changelog change.
