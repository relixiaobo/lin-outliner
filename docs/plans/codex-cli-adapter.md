# Agent CLI Launchers

**Shape:** One complete external-agent execution feature in one PR. The
launcher uses the existing Bash and generic Background Tool Task path; it does
not add a vendor-specific task system or require every harness to share a
private protocol.

## Goal

Let a root Agent run any user-enabled Agent harness through its native CLI.
Tenon owns process lifecycle, background execution, cancellation, timeout,
working-directory isolation, bounded output, and task delivery. The selected
harness owns its command syntax, authentication, tools, and optional session
protocol. Internal Agent execution is exposed through the same launcher
boundary, so internal and external harnesses can run concurrently.

## Non-goals

- Do not make Codex, Claude Code, OpenClaw, or any other vendor CLI a Core
  protocol dependency.
- Do not parse or reconstruct vendor configuration, credentials, MCP servers,
  plugins, Skills, hooks, or model catalogs in Tenon.
- Do not promise a universal resume, usage, JSONL, or sandbox protocol. These
  are optional launcher capabilities and must not be inferred from executable
  discovery.
- Do not silently select a different harness, retry a failed command, or
  upgrade a user-selected executable.
- Do not add a vendor-specific Agent UI or a second process scheduler.

## Design

### One process boundary

The model-facing surface remains ordinary Bash. The built-in Agent CLI Skill
describes how to launch a named, user-enabled harness through Bash stdin. A
canonical launcher command is admitted by the Host into the existing generic
Tool Task scheduler. The scheduler owns process identity, stdout/stderr,
progress, stop, timeout, terminal status, artifacts, and root delivery.

The Host never puts task text in argv, environment, or a temporary file. The
launcher receives task bytes through stdin. Every launcher runs with the
sanitized environment and cwd/worktree selected by the Tool Task admission.

### Launcher contract

A launcher is a small descriptor, not a vendor adapter. It provides:

- a stable user-facing id and label;
- executable discovery and an availability diagnostic;
- the native command prefix or stdin contract needed to start one task;
- optional output/session capability metadata when the launcher can prove it;
- a process invocation function that returns the generic Tool Task result.

The default contract is intentionally small: exit code, bounded stdout/stderr,
duration, cancellation, and optional artifacts. A launcher may expose an
opaque continuation id only when its own output proves one; the generic runtime
stores it without interpreting vendor-specific semantics.

The Codex launcher therefore invokes the installed `codex` CLI directly and
does not pin `codex-cli` to a Tenon release or reconstruct `$CODEX_HOME`.
Codex's own config, authentication, model selection, and extension behavior
remain Codex concerns. The same rule applies to other harnesses.

### Internal and external harnesses

The internal harness is one launcher backed by the existing canonical Agent
executor. External launchers invoke their native CLIs. Both use the same
Background Tool Task lifecycle and return the same bounded task result. An
external child is not granted Tenon tools or a Tenon Agent Session merely
because it is called an Agent harness.

### Multiple enabled launchers

Settings contain an enabled launcher set. Each launcher has its own maximum
access, timeout, pool, and concurrency limits. A default launcher is used when
the request does not name one. A request may name only a launcher that the user
has enabled and the Host currently detects; an unknown, disabled, or unavailable
launcher is rejected before process creation. Existing tasks retain the
launcher selected at admission. There is no fallback.

The user may therefore run Internal, Codex, Claude Code, and OpenClaw tasks at
the same time. Global and per-thread Tool Task limits still apply.

### Optional protocol enrichment

The generic task path does not require a vendor protocol. Future ACP,
Codex app-server, or other protocol integrations may enrich a launcher with
streaming, resume, structured usage, or progress, but those capabilities are
additive and never gate basic CLI execution.

### Settings and user flow

Settings list discovered launchers and let the user enable several at once.
The default launcher and each launcher's access, timeout, pool, and concurrency
are independent. The UI reports unavailable launchers without making them
selectable for a new task.

The root Agent receives one generic Skill. The Skill tells it to select a
configured launcher by id, pass the task through Bash stdin, run in the
background, and report the resulting Tool Task. It does not teach the root
vendor-specific flags; a launcher may inspect its native `--help` output when
constructing a command, but readiness is not based on a web lookup.

## Failure and recovery

- Missing executable, invalid launcher id, disabled launcher, or unavailable
  executable rejects admission before spawning.
- Nonzero exit, signal termination, timeout, malformed optional metadata, or
  output-limit truncation becomes a generic failed/cancelled/timed-out result.
- A launcher process never becomes a nested Tenon Agent, regardless of the
  commands it starts.
- A stopped task is not retried or relaunched automatically.
- Raw Bash remains available for advanced users who intentionally want to run a
  CLI outside the managed launcher contract; its output is an ordinary Bash
  result and receives no Agent Session semantics.

## Open questions

None for the base launcher contract. ACP and vendor-specific resume are future
enrichments, not prerequisites for this feature.

## Verification

Add tests for launcher discovery, multiple enabled launchers, explicit/default
selection, disabled and unavailable admission, concurrent Internal and external
tasks, stdin-only task delivery, sanitized environments, cancellation,
timeouts, bounded output, and generic result delivery. Verify each configured
launcher with its own local `--help`/smoke command where available, without
requiring credentials or a paid provider.
