# Codex CLI Runner Adapter

**Shape:** One complete external Runner feature in one PR. The adapter consumes
the merged internal delegation registry and generic Tool Task runtime; it does
not add a second task system or wait for the independent Claude adapter.

## Goal

Make a locally installed, supported Codex CLI an explicit Delegation Runner.
When the Codex executable and its required capability subset are proven, a user
can enable it in Settings and run or continue one root-owned Agent Session
through the existing `delegate` Skill and background Bash path. Codex output,
failure, cancellation, timeout, and continuation use the same Session and Tool
Task contracts as the internal Runner.

## Non-goals

- Do not expose a model-visible Codex tool or a new delegation command.
- Do not add Claude, ACP, remote A2A, or arbitrary executable adapters.
- Do not pass through Codex user config, plugins, hooks, MCP servers, custom
  Skills, or native Agent/multi-agent features.
- Do not discover credentials, infer Provider/API-key concurrency, log in, or
  silently fall back to the internal Runner, another model, or another Codex
  version.
- Do not claim Ready from executable discovery alone. Unsupported versions or
  unproven capability controls remain Detected / Not Ready.

## Design

### Adapter contract and dispatch

Extend the delegation Runner contract so readiness/model resolution and a
version-bound execution implementation are selected by the frozen `runnerId`
and `runnerVersion`. Keep `DelegationCoordinator` responsible for Session and
settlement truth and keep `ToolTaskService` responsible for process lifecycle;
the adapter only translates a Session Turn into a Codex process and normalizes
its events. Preserve the internal Runner behavior through the same dispatch
contract, so no second settlement path is introduced.

The adapter receives the resolved prompt, ordered continuation messages,
Session policy, cwd/worktree, effective tool ceiling, timeout, and abort signal.
It returns the existing `DelegateExecutionResult` shape, including a bounded
answer, partial evidence, usage when available, and a local continuation
identity. Provider credentials remain in Codex's own authenticated runtime and
never enter argv, environment, prompts, or persisted delegation records.

### Version probe and capability map

Probe a configured executable path and PATH candidate with a bounded
`codex --version` process. Bind readiness to the exact reported version and
retain a diagnostic for missing, nonzero, or unsupported probes. For the
supported version (initial evidence is `codex-cli 0.153.4`), run fixture probes
for the exact non-interactive flags and JSONL event contract before marking
Ready.

Publish an `AdapterCapabilityMap` covering only the admitted subset:

- read-only sessions use `--sandbox read-only`;
- workspace-write sessions use `--sandbox workspace-write` only when the
  existing worktree boundary and Codex behavior prove that subset;
- cwd is passed with `--cd` and the model only with the Settings-resolved
  `--model` value;
- non-interactive execution uses `exec`, stdin prompt input, and `--json`;
- the run uses a controlled user-level config/profile layer rather than
  `--ignore-user-config`: official Codex behavior says that flag ignores the
  entire `config.toml`, including `model_provider` and `model_providers`, while
  authentication still reads from `CODEX_HOME`;
- the controlled layer explicitly sets the selected custom provider fields,
  `features.multi_agent = false`, `features.hooks = false`, `features.apps =
  false`, `web_search = "disabled"`, `history.persistence = "none"`, and a
  narrow shell environment policy; project rules are still excluded with
  `--ignore-rules`;
- every configured MCP server, plugin, skill, notification hook, and other
  extension must be absent or explicitly disabled. Codex only exposes
  per-server MCP disablement (`mcp_servers.<id>.enabled`), so if the adapter
  cannot enumerate and close the complete extension set it remains Not Ready
  rather than reusing the user's full config;
- native Agent/multi-agent, background, MCP, network, and unclassified tools
  are denied. If any disable or sandbox guarantee cannot be proved, the
  affected access mode is Not Ready rather than widened implicitly.

The adapter must remove known Agent executable locations from the child PATH as
defense in depth, while documenting that arbitrary shell commands are not
structurally classified as nested Agents.

### Execution, continuation, and process control

Construct argv from a closed builder; never interpolate prompt or user text.
Parse Codex JSONL into bounded textual evidence, terminal outcome, usage, and a
version-bound session identifier. A successful first Turn stores only the
minimum local resume identity required by Codex `exec resume`; continuation
must use that identity plus the next message at a fresh safe Turn boundary.
If the installed version cannot provide safe local resume and closure, the
adapter remains Not Ready even if first-run execution works.

Run Codex in the supervisor-owned process group. Propagate the Tool Task abort
signal, timeout, and user stop to the process group and wait for quiescence
before returning the normalized terminal result. A nonzero exit, malformed
JSONL, missing terminal event, broker loss, or resume rejection becomes a
standard failed/lost result with preserved bounded partial evidence; it never
retries or starts a replacement Session.

### Settings and readiness

Register `codex` in the Host Runner registry and expose its live readiness row
through the existing Delegation Settings surface. Keep the experiment switch,
per-Runner enabled state, timeout, access ceiling, pool, and concurrency
controls unchanged. Offer `Harness default` unless the adapter can enumerate a
finite, validated Codex model catalog; explicit model choices must resolve at
admission and unavailable choices reject before Session creation or Provider
I/O. Existing Sessions retain their frozen Codex version/model/access policy;
changing Settings affects only new Turns after the normal continuation
availability check.

Provider authentication is a readiness input, not an implementation shortcut.
The official configuration supports custom providers with `base_url`,
`wire_api`, `env_key`, or a command-backed auth helper. The adapter may use
only a declared environment variable or user-approved credential helper; it
must never copy, parse, or persist credential contents. A provider that can run
only by reusing an opaque full user config is Detected / Not Ready.

### Files and tests

Primary implementation areas are the delegation Runner contract and registry,
the new versioned Codex adapter/CLI process module, Host composition and
runtime dispatch, Settings readiness/model presentation, and the delegation
specification. Add focused tests for version probes, closed argv/config,
sandbox/access mapping, disabled native capabilities, JSONL normalization,
malformed output, cancellation/timeout, resume identity, version drift,
explicit-model refusal, and registry readiness. Add a fixture-backed end-to-end
Tool Task run and one opt-in real CLI evidence test that is skipped without a
usable local Codex installation; the skip must not make an unsupported adapter
Ready.

## Risks and collision result

- Codex CLI output and resume flags are version-bound; fixtures must gate every
  claimed capability and preserve Not Ready on drift.
- The current runtime is internal-only, so dispatch changes must preserve all
  existing internal settlement and recovery tests.
- Closed configuration and sandbox mistakes could widen filesystem, network,
  or nested-Agent authority; fail closed at readiness and admission.
- A local executable is not evidence of authentication or Provider capacity.

Collision self-check on 2026-09-05: no open PR claims the delegation Runner
adapter or its registry/runtime files. PR #636 is Settings file-backed design
work and is a separate Settings control-plane concern; this adapter must
rebase on its merged contract before touching shared Settings ownership. PR
#634 is renderer interaction work and has no overlap.

## Open questions

- Which Codex model catalog, if any, can be enumerated without reading or
  mutating user credentials? Until answered, use `Harness default`.
- Which exact Codex configuration mechanism proves hooks, MCP, network, and
  native multi-agent capabilities are closed for the supported version? Any
  unresolved capability keeps the corresponding access mode Not Ready.
- Can the selected third-party provider be represented by a controlled profile
  using an `env_key` or command-backed auth helper? If not, the adapter must
  expose the diagnostic and refuse activation rather than reuse the full user
  config.

## Verification

Run the delegation Core tests, adapter fixture suite, renderer Settings tests,
`bun run typecheck`, `bun run docs:check`, and the packaged/source CLI smoke.
Record the real `codex-cli 0.153.4` probe and a successful/failed controlled
run as PR evidence without committing credentials or user configuration.
