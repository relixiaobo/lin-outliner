# Development Process Lifecycle

## Goal

Deliver one complete feature: an Agent-started development server remains available
for the user's testing after the initiating Turn ends, and the Agent can verify its
readiness without stopping it.

## Non-goals

- No new tool, terminal engine, verification engine, daemon, or process adoption.
- No promise that owned processes survive orderly application Quit.
- No change to delegated Agent deadlines or the broader startup recovery design.

## Design

### Process lifetime and observation

Keep `bash` and `task_status` as the existing interfaces. An explicit background
Bash call without `timeout` has no elapsed-time deadline; an explicit positive
timeout remains enforced. Foreground calls retain their 120-second default.
Delegate scheduling keeps its configured deadline. Persist a nullable Task timeout
and carry it unchanged to the standalone supervisor. Stop, output ceilings,
ownership reconciliation, and orderly Quit still apply.

Expose bounded, sanitized running output through `task_status` as a timestamped
observation, separate from its terminal result. Freeze a log prefix bounded by the
Task detail ceiling and redact its complete lines from the beginning before selecting
the visible tail. Preserve multiline secret context and redact unfinished private-key
blocks through the observation's end. Use the existing scanner worker for large
captures; withhold raw text on scan failure or an oversized/shortened capture.
Do not change the producer's output files or publish a final receipt. Apply the
existing untrusted-output treatment and serialized result budget. A running
observation does not prove application readiness.

### Nested application startup

The ordinary shell environment excludes ambient Electron development control
variables; explicit per-command environment overrides remain possible. Preserve
the existing Outline CLI environment needed to operate the owning application.
The desktop's own Outline launch resolves its entry and interpreter from that
desktop's source/package, rather than mistaking inherited CLI exports for a
desktop launch override.

### Agent workflow

Update the development Skill and tool guidance: keep requested servers running,
inspect startup logs and perform an appropriate readiness check, and distinguish
process existence from usable application state. Diagnose failures within the
existing user authorization. Completion notifications carry evidence and do not
cancel the original request or require the user to restate it.

### Files and integration

Touch the Bash producer/environment, Tool Task store/service/supervisor types,
`ToolRuntime`, the `task_status` contract in `src/core/agent/tools.ts`, the Outline
desktop launch resolver, development Skill, focused Core tests, and relevant
agent/Outline specifications. Do not change dependencies, core document commands,
the shared board, or the changelog.

This feature follows PR #661 and preserves its bounded output projections.
PR #662 owns web search; it shares the tool specification but none of
this feature's implementation functions. Its search changes remain independent.

### Risks and validation

The nullable timeout changes the development Task store format. Follow the
repository's pre-release policy: use fresh isolated data for validation and reset
development data when adopting the new format; do not add a migration or modify a
currently running profile during implementation.

Cover persistent lifetime, explicit deadlines, Turn completion, manual Stop,
orderly Quit, supervisor reattachment, bounded/redacted running output, and
terminal output compatibility. Reproduce nested Outline launch with inherited
CLI exports and verify a real Runtime connection. Run a real development-process
probe beyond the former 120-second deadline, followed by explicit teardown.

## Open questions

None. The user explicitly requires the started development application to remain
available for manual use and testing.
