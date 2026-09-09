# Execution Sandbox And Interactive Processes

**Shape:** One complete feature. It records actual process isolation and tests
interactive development through the existing Bash/Tool Task path under the
[Agent Capability-First Development Workbench](project-development-workbench.md).

## Goal

Make process execution truthful and inspectable while preserving Full Access as
the default. Measure whether `tmux` plus Tool Tasks is sufficient before adding
native persistent process semantics.

## Non-goals

- A user-facing sandbox mode by implication.
- Claiming portable OS isolation without a tested backend.
- A model-facing sandbox tool.
- A native persistent terminal before a reproducible gap is measured.

## Design

### Isolation contract

Resolve before spawn:

```text
requested isolation + capability ceiling + worktree policy
platform/backend + filesystem roots + network mode
dependency result + enforcement state
```

The receipt uses exactly:

```text
sandboxed | unsandboxed | unavailable | rejected
```

`unsandboxed` is truthful Full Access when no OS boundary is enforced.
`unavailable` means requested isolation could not initialize and the process
does not start. Electron sandboxing, read-only capability, worktree identity,
and OS sandbox enforcement remain separate receipt properties.

The existing delegation/native-launcher policy still requires a dedicated
worktree for effective writable access and disposable worktrees for external
read-only execution. This unit does not make those resources optional. A
worktree redirects normal relative work but is not an OS boundary around an
arbitrary native CLI. Address claims likewise coordinate declared scopes only;
neither property can justify a `sandboxed` receipt. Platform enforcement must
be measured before promising containment of absolute-path shell effects.

### Interactive process experiment

The development Skill uses a unique session name derived from the Thread,
execution address, and worktree identity. Tool Tasks record command, cwd,
environment policy, session name, capture path, owner, and lifecycle state.

```text
start -> poll/capture -> write input -> stop -> reopen
```

The experiment must prove no duplicate process on retry, bounded output,
correct cancellation, restart discovery, and inherited capability/worktree
limits. `tmux` state is evidence, not a second process ledger.

### Model context

Use the common
[Execution Context Publication](../spec/agent-model-runtime.md#execution-context-publication)
contract for isolation facts and process updates. Keep canonical tool names,
descriptions, and schemas independent of the current cwd, session name, and
per-process policy. Actual enforcement and actionable failures belong to the
admitted task/result, not dynamically rewritten system instructions. A genuine
capability revocation still applies immediately under its owner contract,
regardless of any cache cost.

Each poll/capture is a new observation with bounded, frozen output; do not
rewrite old captures to show the latest terminal or repeatedly inject the full
process list and unchanged Skill body. Prefer changed output or a bounded
current capture when supported by the CLI. Compaction retains references to
owned processes and observed lifecycle facts; it never declares a process alive
without reconciliation or starts another process to reconstruct context.

### Reference mechanisms

Codex process ownership and sandbox resolution are the primary execution
reference. Claude's sandbox adapter and task output provide failure and
background semantics. Pi's tmux workflow and optional sandbox extension provide
the experiment shape. Tenon's Tool Task receipt and process executor remain the
authority.

## Requirements

- **FR-1:** Every Tool Task records requested isolation and actual enforcement.
- **FR-2:** Requested isolation fails closed when its backend is unavailable.
- **FR-3:** Interactive process ownership and recovery are measured before a
  native persistent-session capability is proposed.
- **FR-4:** Isolation and process observations use the common context contract
  without task-specific tool-schema or stable-prompt changes.

## Acceptance criteria

- **AC-1:** Full Access tasks expose `unsandboxed` where no OS sandbox applies.
- **AC-2:** An unavailable requested sandbox never silently executes unrestricted.
- **AC-3:** macOS isolated shells enforce their tested writable roots and
  protected Git object rules.
- **AC-4:** The tmux experiment starts, captures, accepts input, stops, and
  reopens one owned session, or records the failed property.
- **AC-5:** No native persistent terminal is added without experiment evidence.
- **AC-6:** Repeated captures preserve earlier request prefixes and bounded
  output; restart/compaction reconciles the original process without a duplicate
  start. Task-directory changes leave tool schemas and cache affinity unchanged.

## Tests and evidence

Add receipt/codec tests, dependency-failure tests, macOS profile tests, denied
write/network tests where supported, and restart/duplicate-process/output-loss
evidence for tmux. Linux and Windows are separate experiments.
Include repeated capture and compacted-continuation provider fixtures alongside
the process receipts, with actual runtime enforcement checked independently.

## Open questions

- Network restriction requires a separate backend experiment.
- The Skill may probe tmux, but must not silently substitute an unowned process
  session when unavailable.

### Implementation binding

- Extend the existing Task projection and terminal receipt with requested
  isolation, canonical write roots, protected Git object stores, backend/network
  policy, and actual enforcement evidence. A pending Task has no enforcement
  result; admission policy alone cannot attest to a running sandbox. Host file
  boundaries remain distinct from OS process isolation.
- Apply the macOS profile to the supervised command. Keep the canonical
  supervisor outside that write boundary so it can retain output and receipts
  without granting the command access to Task metadata. A private acknowledgement
  from inside the applied profile proves activation before the command executes;
  missing acknowledgement or backend failure never falls back to unrestricted
  execution. Persist the result for restart and detail retention.
- Publish isolation/process observations through existing context resources and
  frozen provider boundaries. Task details show the recorded result. Any Task
  storage/receipt format change is a pre-release clean cut, with no legacy reader.
- Run a reproducible, bounded tmux experiment against the real Tool Task service
  using a private socket and deterministic owner/address identity. Measure
  duplicate starts, input/capture, termination, Host recovery, output retention,
  and isolated writes. Record failed properties as well as passes in the current
  specification; do not introduce a native terminal in this feature.
- Scope: Agent process executor, Task service/store/supervisor and receipt codecs,
  context publication, Task detail presentation, development Skill, focused
  tests, experiment driver, and Agent specifications. Settings #656 overlaps only
  separate specification/locale sections; it does not claim these process owners.
  No dependency, build configuration, document protocol, board, or changelog
  edits are needed for implementation.
