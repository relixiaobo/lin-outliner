# Agent Bash Stdin Transport

## Goal

Give the existing `bash` tool one bounded, durable, literal stdin channel so a
model can pass structured text to a CLI without placing data in shell grammar,
process arguments, the environment, or a temporary file. The immediate consumer
is the public `outline ... --input -` workflow, but the transport and its
security classification belong to the generic Agent Bash boundary.

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
  field extends the current pre-release schema without changing stored calls
  that omit it.

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
  `stdin: string`. Unknown fields, non-string values, and invalid bounds keep the
  existing schema/normalization failure path and never spawn a process.
- **FR-2:** The admitted UTF-8 bytes are exactly `Buffer.from(stdin, 'utf8')`.
  Empty input is distinct from omitted input; line endings and Unicode are not
  normalized.
- **FR-3:** Bash uses the existing durable tool-argument payload budget as its
  upper authority instead of inventing a larger, non-replayable input class.
  Admission measures the complete canonical Bash arguments in UTF-8 and rejects
  them before spawn when they cannot be retained by the existing
  `MAX_THREAD_CONTEXT_PAYLOAD_BYTES` boundary. The accepted range must include a
  legal request containing one current 4,194,304-character Outline scalar plus
  its JSON envelope.
- **FR-4:** Canonical model-call history retains the admitted argument through
  the existing inline-or-payload mechanism and existing structural secret
  redaction. Bash adds no duplicate stdin logging, output echo, command summary,
  environment copy, or persisted temporary input.

The payload budget is a Bash transport and durable-history fact. It does not
modify or narrow any downstream CLI schema. A downstream command may continue
to accept larger files or other native input channels outside the Agent Bash
tool.

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

- **FR-5:** Registered-data recognition is fail-closed and command-shaped. It
  accepts only one direct executable invocation whose parsed argv matches a
  host-owned stdin contract. Compound shell commands, wrappers, substitutions,
  pipelines, redirections, and extra shell segments cannot inherit a data
  registration. The initial registry includes direct public Outline commands
  that explicitly select `--input -`; no Outline code is imported into the
  transport writer.
- **FR-6:** Executable recognition covers the existing interpreter vocabulary
  and the argv forms that make stdin source code, including shell `-s`, Python
  `-` or no-script execution, and equivalent Node, Deno, Bun, Ruby, Perl, PHP,
  and AppleScript stdin modes. The classifier inspects argv only. It never reads
  payload text to decide whether the program appears safe.
- **FR-7:** An unregistered or ambiguous stdin consumer is `unknown`, not data.
  Future data consumers require one explicit command-contract registration and
  focused positive and adversarial tests.
- **FR-8:** Capability evaluation, user blocks, constrained-Agent execution, and
  audit consume the same classification result or the same shared helper. No
  second parser may independently decide that stdin is data or executable.

The existing `shell.local_code_execution` and `shell.unknown` action kinds are
sufficient. This feature adds no Core action kind and no public permission
vocabulary.

### 4. Policy And User-block Semantics

- **FR-9:** A `registered-data` call follows its direct command actions. Direct
  `outline show` through stdin remains `outline.read`; direct `outline add`,
  `commit`, or another mutation remains `outline.edit`; destructive public
  commands retain `outline.delete`. Stdin content cannot add or remove actions.
- **FR-10:** Worktree, read-only, Plan, and Explore Agents reject `executable`
  and `unknown` stdin before process launch. This is stricter than ordinary
  worktree local-code execution because worktree filesystem isolation cannot
  isolate a program supplied through stdin from the live Outline Runtime or
  another host service.
- **FR-11:** Worktree Agents may execute only registered-data stdin calls whose
  existing actions are otherwise permitted. A direct `outline.read` call is
  allowed; `outline.edit` and `outline.delete` remain rejected. Read-only, Plan,
  and Explore retain their current proven-read-only action requirements.
- **FR-12:** Root Full Access behavior remains default-allow. Known executable
  stdin carries `shell.local_code_execution`, unknown stdin carries
  `shell.unknown`, and direct data consumers carry their existing action kinds,
  so `Action(...)` blocks apply before spawn. Existing normalized
  `Command(...)` blocks continue to match `command` and never inspect payload
  text.
- **FR-13:** Rejection reports the effective consumer and blocked existing
  action without echoing stdin. It does not advise encoding, obfuscating,
  wrapping, or moving the same program into another transport.

### 5. Foreground Stream Lifecycle, Failure, And Recovery

- **FR-14:** Omitted stdin preserves `stdio: ['ignore', 'pipe', 'pipe']` and all
  current foreground/background behavior. Present stdin uses a piped child
  stream only after schema, capability, and constrained-policy admission.
- **FR-15:** Output capture and child error listeners attach before input
  delivery starts. The writer honors Node stream backpressure, closes stdin
  exactly once after the complete payload, and treats write, drain, early-close,
  and child-stdin errors as part of the same Bash settlement.
- **FR-16:** Abort and timeout stop input delivery and the process tree through
  the existing interruption path. Input failure cannot leave an unhandled stream
  error, report success, or start a second settlement. Native child exit and
  interruption evidence remain visible.
- **FR-17:** `stdin` with `run_in_background: true` fails before spawn. A
  foreground command carrying stdin is ineligible for auto-backgrounding. This
  feature does not create a durable background-input lifecycle or hand an
  unsettled writer to the background task registry.
- **FR-18:** Bash never retries a command after input or process failure. A
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
2. the same command retains its read/edit/delete action for explicit blocks and
   worktree policy;
3. executable and unknown stdin never spawn in worktree, read-only, Plan, or
   Explore contexts; and
4. Full Access plus no matching block reaches the child once and settles once.

## Dependency And Collision Boundary

This foundation is a prerequisite of the Draft
`outline-cli-skill-efficiency` PR. It does not depend on that feature or Source
PR-I, and it modifies no Outline path. The consumer PR rebases after this
foundation merges and verifies only the public `stdin` interface end to end.

The collision self-check found one open PR, `outline-cli-skill-efficiency`, whose
current plan discusses this missing interface but claims no generic Agent file.
That PR will replace its embedded foundation design with a dependency link. No
other open PR currently claims the expected files below. A fresh `gh pr list`
and actual-diff check run again immediately before implementation.

## Implementation Boundary

Expected implementation ownership:

- `src/main/agent/capabilities/agentLocalTools.ts` for the public parameter,
  byte admission, foreground writer, and background rejection;
- `src/main/agent/capabilities/agentCapabilities.ts` for the single parsed
  command/action/stdin-consumer classification;
- `src/main/agent/capabilities/subagentToolPolicy.ts` and
  `src/main/agent/runtime/ToolRuntime.ts` for consuming that same classification
  at constrained execution;
- `docs/spec/agent-tool-design.md` and
  `docs/spec/agent-integration.md` for current behavior; and
- `tests/core/agentLocalTools.test.ts`,
  `tests/core/agentCapabilities.test.ts`,
  `tests/core/agentSubagentToolPolicy.test.ts`, and one focused existing
  ToolRuntime/Thread integration test file for the real composition boundary.

This feature does not modify `src/core/agent/tools.ts`, Core document protocol,
file tools, Outline code or fixtures, another built-in Skill, renderer code,
dependency manifests, workflows, `docs/TASKS.md`, or `CHANGELOG.md`. If a new
action kind, public capability protocol, generic result projection, or broader
process abstraction proves necessary, stop and return that interface decision
to PM review instead of widening this PR.

## Open questions

There are no unresolved product questions. Ratification accepts the optional
UTF-8 string field, durable payload-bound admission, four-state consumer model,
constrained-policy failure, Full Access behavior, and foreground-only lifecycle
together. Exact private helper names and the focused integration test file are
reversible implementation details selected from the rebased tree.

## Acceptance criteria

### Transport And Settlement

- [ ] **AC-1:** Bash schema and canonical history expose optional
  `stdin: string`; calls that omit it retain byte-for-byte current execution and
  stored argument behavior.
- [ ] **AC-2:** A legal structured payload larger than macOS `ARG_MAX`, including
  one 4,194,304-character scalar, reaches child stdin intact while command argv,
  environment, stdout/stderr, and the child workspace contain no transport copy;
  canonical tool-call history is the only retained argument copy.
- [ ] **AC-3:** Empty input, quotes, multiline text, backticks, literal `$()`
  expressions, Unicode, NUL, and candidate heredoc delimiters arrive with the
  exact UTF-8 bytes and execute no payload content as shell syntax.
- [ ] **AC-4:** Complete write, forced backpressure, early child exit, stdin
  error, abort, and timeout each settle once, close or stop the writer, leave no
  unhandled stream error, and preserve native exit/interruption evidence.
- [ ] **AC-5:** Oversized canonical Bash arguments, non-string stdin, and
  `stdin + run_in_background` fail before spawn; a stdin-bearing foreground call
  never auto-backgrounds.

### Classification And Authority

- [ ] **AC-6:** One shared classifier returns `absent`, `registered-data`,
  `executable`, or `unknown` from command structure and stdin presence without
  reading stdin text; capability and constrained execution consume the same
  result.
- [ ] **AC-7:** Direct registered `outline ... --input -` calls preserve the
  capability registry's exact `outline.read`, `outline.edit`, and
  `outline.delete` actions under adversarial document payloads.
- [ ] **AC-8:** Shell `-s`, Python `-` and no-script forms, and equivalent
  supported interpreter forms classify as executable stdin and include
  `shell.local_code_execution`; wrappers, compound commands, and unregistered
  consumers cannot classify as registered data.
- [ ] **AC-9:** Worktree, read-only, Plan, and Explore policy tests reject every
  executable and unknown stdin case before spawn while preserving an allowed
  direct registered read and rejecting direct registered Outline mutation.
- [ ] **AC-10:** User-block tests prove `Action(outline.edit)`,
  `Action(shell.local_code_execution)`, `Action(shell.unknown)`, and normalized
  `Command(...)` decisions remain unavailable before spawn for their matching
  stdin calls; stdin text cannot change the match.
- [ ] **AC-11:** A Full Access root call with no matching block can execute one
  registered-data, executable, or unknown stdin consumer once, and its audit
  evidence reports command and consumer class without payload contents.

### Repository Gates

- [ ] **AC-12:** A production-composition test crosses canonical argument
  admission, capability evaluation, constrained policy, child input, and final
  settlement rather than reconstructing those boundaries in a test helper.
- [ ] **AC-13:** Focused `agentLocalTools`, `agentCapabilities`,
  `agentSubagentToolPolicy`, and ToolRuntime/Thread integration tests pass.
- [ ] **AC-14:** `bun run typecheck`, `bun run test:core`, `bun run docs:check`,
  and `git diff --check` pass.
- [ ] **AC-15:** An executable diff allow-list proves the PR changes only the
  generic Bash/capability/policy/runtime files, named specs, and focused tests
  above; it contains no Outline, file-tool, renderer, Core action-kind,
  dependency, workflow, board, or changelog change.
