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

## Acceptance criteria

- **AC-1:** Full Access tasks expose `unsandboxed` where no OS sandbox applies.
- **AC-2:** An unavailable requested sandbox never silently executes unrestricted.
- **AC-3:** macOS isolated shells enforce their tested writable roots and
  protected Git object rules.
- **AC-4:** The tmux experiment starts, captures, accepts input, stops, and
  reopens one owned session, or records the failed property.
- **AC-5:** No native persistent terminal is added without experiment evidence.

## Tests and evidence

Add receipt/codec tests, dependency-failure tests, macOS profile tests, denied
write/network tests where supported, and restart/duplicate-process/output-loss
evidence for tmux. Linux and Windows are separate experiments.

## Open questions

- Network restriction requires a separate backend experiment.
- The Skill may probe tmux, but must not silently substitute an unowned process
  session when unavailable.
