# Execution Sandbox And Interactive Processes

**Shape:** One complete feature. It records actual command isolation and
measures whether `tmux` plus Tool Tasks is sufficient before adding a native
persistent process capability. It clarifies the current Full Access baseline;
it does not introduce a selectable permission mode.

## Goal

Make the execution boundary truthful and inspectable. Every Tool Task reports
whether it is sandboxed, unsandboxed, unavailable, or rejected, and interactive
development is tested with an owned `tmux` workflow.

## Purpose

Define the execution trust boundary and the experiment that determines whether
Tenon needs native persistent process support.

## Non-goals

- Claiming cross-platform OS sandboxing without a tested backend.
- A model-facing sandbox tool.
- A native persistent terminal before the `tmux` experiment demonstrates a
  reproducible reliability gap.

## Reference implementation

| Reference | Source | Logic to study | Adaptation |
|---|---|---|---|
| Codex CLI | `codex-rs/core/src/tools/handlers/unified_exec/` and process manager modules | Process identity, PTY, polling, stdin, cancellation, cleanup, sandbox and approval resolved before spawn | Extend Tool Task receipts; add native session only after the experiment |
| Codex CLI | `codex-rs/core/src/sandbox/` and exec policy code | Platform-specific sandbox and network/approval policy | Use the ownership model; do not claim portability before backend tests |
| Claude Code | `src/utils/sandbox/sandbox-adapter.ts` | Settings conversion, dependency checks, `failIfUnavailable`, violation reporting | Adopt explicit unavailable/refusal semantics |
| Claude Code | `node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/{macos-sandbox-utils,linux-sandbox-utils,sandbox-manager}.js` | Seatbelt, bubblewrap/seccomp, proxy-based network restriction, cleanup | Evaluate as a Host dependency, never as untrusted Skill code |
| Claude Code | `src/utils/task/LocalShellTask.ts`, `src/TaskOutput.ts` | Background task output and task retrieval | Compare against Tool Task before native PTY |
| Pi | `packages/coding-agent/examples/extensions/sandbox/index.ts` | Optional sandbox extension wrapping the same runtime; explicit warning on disable/failure | Use as an extension experiment only; Host must not silently degrade |
| Pi | `packages/coding-agent/docs/tmux.md`, `src/core/bash-executor.ts` | External `tmux`, abort, timeout, bounded output | Use `tmux` for the first interactive workflow |
| Tenon | `src/main/agent/capabilities/agentProcessExecutor.ts` | macOS `sandbox-exec` write profile and protected Git object stores | Apply consistently to eligible isolated shells |
| Tenon | `src/main/agent/tasks/ToolTaskService.ts`, `ToolTaskStore.ts`, `agentLocalTools.ts` | Durable command ownership, leases, output, stop, reconciliation | Persist sandbox decision with the existing task receipt |

## Design

### Sandbox contract

Resolve before spawn:

```text
requested isolation policy + capability ceiling + worktree boundary
platform/backend + filesystem roots + network mode
dependency result + enforcement state
```

The receipt uses exactly four enforcement states:

```text
sandboxed | unsandboxed | unavailable | rejected
```

`unavailable` means the requested backend or dependency cannot be initialized;
the process does not start under that requested mode. `unsandboxed` is allowed
when the existing Full Access product contract permits it, and must be visible
in evidence. It is not a second user-facing permission mode. Electron sandbox,
read-only classification, and worktree containment are recorded as separate
properties and never substituted for OS sandbox enforcement.

The first implementation measures the existing macOS write boundary in
`agentProcessExecutor.ts`, including writable roots and protected Git object
stores. This is the only currently enforced Agent-process isolation path; a
plain Full Access Bash task may legitimately record `unsandboxed`. Linux and
Windows are separate experiments. Network restriction is not claimed until
denied hosts, allowed hosts, proxy failure, and cleanup are tested.

### Interactive process experiment

The development Skill creates a session name derived from Thread, execution
target, and worktree, with a collision-resistant suffix. It records command,
workspace identity, cwd, environment policy, session name, capture path, owner, and
lifecycle state. Bash/Tool Tasks perform:

```text
start -> poll/capture -> write input -> stop -> reopen
```

The experiment must prove no duplicate process on retry, bounded output capture,
correct cancellation, restart discovery, and inherited capability/worktree
limits. `tmux` server state is evidence, not a second process ledger.

If any property fails reproducibly, a later plan may add generic native
`start/poll/write/stop` semantics backed by Tool Task receipts and the same
sandbox/approval/cleanup path.

## Requirements

- **FR-1:** Every Tool Task records requested isolation policy and actual
  enforcement state.
- **FR-2:** Requested isolation fails closed when the backend is unavailable.
- **FR-3:** Interactive process ownership and recovery are measured before a
  native session capability is proposed.

## Acceptance Criteria

- **AC-1:** Every Tool Task receipt exposes requested isolation policy and actual
  enforcement state.
- **AC-2:** Requested isolation cannot silently execute as unrestricted Full Access.
- **AC-3:** The current Full Access baseline records `unsandboxed` in the task
  receipt where no OS sandbox is enforced; this fact is not repeated in the
  default Composer.
- **AC-4:** macOS isolated shells enforce writable roots and protected Git object rules.
- **AC-5:** `tmux` can start, capture, accept input, stop, and reopen one owned session, or
  records a reproducible failed property.
- **AC-6:** No native persistent terminal is added without the experiment's evidence.

## Tests and evidence

Add unit tests for state transitions, dependency failure, receipt decoding, and
macOS profile construction. Run a controlled command that attempts a denied
write and a denied network operation where supported. Capture the `tmux`
experiment across restart and record duplicate-process/output-loss results.

## Open questions

- Sandbox unavailability blocks only the requested Tool Task and returns an
  explicit non-success result; the Turn may continue with inspection or another
  admitted action.
- The first two profiles use no additional network restriction beyond the
  existing Full Access contract. A future restriction requires a separate
  backend experiment.
- The Skill host-probes `tmux`; unavailable platforms record a failed
  experiment and do not silently substitute an unowned persistent process.
