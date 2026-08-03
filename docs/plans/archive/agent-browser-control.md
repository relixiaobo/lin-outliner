# Agent Browser Control

## Goal

Let an Agent use Browser Pilot `v0.5.0` to operate the user's eligible Chrome tabs
with the user's existing Profiles, signed-in sessions, cookies, extensions, and
website state.

The public integration remains exactly the one Browser Pilot publishes:

```text
Agent
  -> Browser Pilot skill
  -> Tenon bash tool
  -> short-lived bundled bp CLI
  -> shared per-user Browser Pilot Broker
  -> user's Chrome
```

The implementation also establishes a clean Agent execution boundary: raw tool
arguments and results may be used for one active Turn, while Items, extension
hooks, history, Memory, diagnostics, and payload storage receive only explicit
durable projections.

URL Preview remains an unrelated Tenon-owned quick-preview surface. It shares
no browser process, Profile, cookies, targets, controller, lifecycle, or Agent
contract with Browser Control.

## Non-goals

- Do not attach Electron CDP to URL Preview guests or make Preview controllable
  by an Agent.
- Do not add Browser Pilot-native model tools, MCP, `bridge --stdio`, a native
  SDK, a browser extension, or a persistent Browser Pilot client.
- Do not import Browser Pilot private Broker, Workspace, Lease, Command,
  Observation, or Artifact protocols.
- Do not reimplement browser discovery, authorization, Profile routing, refs,
  target ownership, command recovery, or Broker cleanup.
- Do not discover a global `bp`, run `npx`, install packages, or download
  Browser Pilot during an Agent task.
- Do not let the model choose the executable, client key, output root, process
  environment, or human-output mode.
- Do not infer the business meaning of an arbitrary browser click, keystroke,
  script, or form control.
- Do not add a Tenon approval flow or weaken the existing Full Access plus
  explicit-block capability model.

## Shape

This is one complete feature in one PR. The PR first establishes the generic
prepared-execution boundary, then uses it for the Browser Pilot integration;
neither part ships independently.

The feature is complete only when a packaged Tenon Agent can discover the
bundled skill, invoke the bundled CLI through `bash`, connect to the user's
browser, complete and verify a task, recover uncertain work, consume generated
files, isolate concurrent Threads, and delete one Thread without closing
unrelated user tabs.

## Collision Result

- Current `main` includes #444's provider-boundary Turn diagnostics, #445's
  Tenon-owned kernel and `ModelGateway`, #451's `thread/` ownership split, and
  #456's domain-handler contribution seam plus canonical tool-catalog
  byte-stability judge. Those changes are the implementation baseline, not
  outstanding collisions. Current `main` also records the revised gate-return
  plan baselines for #455 and #460; neither implementation PR has landed.
- Draft PR #455 overlaps the future implementation in
  `src/core/agent/tools.ts`, `ThreadService`, `TurnLifecycle`, and Agent specs,
  and deliberately changes collaboration tool descriptions. It must land or
  close before Browser Control implementation starts; the claiming dev then
  rebases and records the post-#455 catalog bytes before making any intentional
  Browser Control catalog delta.
- Draft PR #460 claims `subagent-transcript-artifact`. It overlaps the
  future implementation in `src/core/agent/tools.ts`, `ThreadService`,
  `SubagentCollaboration`, `ThreadCatalogOps`, `agentSkills.ts`, Agent specs, and
  the catalog snapshot. It must land or close before Browser Control
  implementation starts; the later branch rebases and treats #460's snapshot
  as part of its catalog baseline.
- The three active UX plans have mixed claim state. Ready PR #458 claims
  `agent-thread-scroll-follow`; its renderer-only scope does not overlap this
  revision or the Browser Control backend. Ready PR #461 claims
  `agent-run-presentation-consistency` PR A and changes one disjoint
  `PiTurnExecutor.ts` result-detail line; it is a rebase note for the future
  Browser branch, not an implementation conflict or ordering gate.
  `agent-subagent-interaction` remains unclaimed. Its future
  `SubagentCollaboration`, `TurnLifecycle`, and `ThreadCatalogOps` work overlaps
  Browser lifecycle wiring, so implementation must repeat the open-PR scope
  check before claiming code.
- Draft PR #457 is plan-only in a different file and does not overlap this
  revision.
- Ready PR #459 owns this plan-only refresh. It changes only this file; it does
  not claim or modify runtime, protocol, tests, `docs/TASKS.md`, or
  `CHANGELOG.md`.
- `docs/plans/browser-extension-integration.md` remains limited to future
  read-only URL Preview extraction and has no Browser Control dependency.
- The later implementation PR remains one complete feature and owns the
  prepared-execution port extension, Browser action kinds, Browser Pilot
  distribution, command provider, built-in skill, specs, and tests.
  `docs/TASKS.md` and `CHANGELOG.md` remain main-agent-owned.
- This refresh records only the PM-decided Prepared Tool Execution rewrite,
  unclassified-command capability rule, deferred distribution evolution, launch
  platform, sensitive-read default, conversational authorization, and stale
  runtime/collision facts. Ownership boundaries, shell-safety grammar,
  provider, distribution verification, skill packaging/availability, and
  process policy retain their prior approval.

## Design

### Ownership Boundary

Browser Pilot owns Chrome and the public CLI behavior: browser authorization,
Profiles, tabs, frames, refs, target locking, network rules, files, structured
errors, request deduplication, command recovery, and shared Broker lifecycle.

Tenon owns the host boundary around that CLI: reproducible distribution,
Thread identity, Turn files, command routing, capability evaluation, process
policy, cancellation compatibility, model-visible result projection, durable
projection, and Thread-deletion cleanup.

Tenon depends only on Browser Pilot's published 0.5 contracts:

- `BROWSER_PILOT_CLIENT_KEY` and `BROWSER_PILOT_OUTPUT_DIR`;
- JSON success and failure envelopes with stable `code`, `retryable`,
  `context`, and `remediation` fields;
- `status`, `commands`, `command`, `cancel`, and `wait` recovery commands;
- per-operation `--request-id` and `--timeout`;
- absolute file-result metadata; and
- signal cancellation and `unknown_outcome` semantics.

### Prepared Tool Execution

Prepared execution extends the domain-handler contribution seam established by
#456. The collaboration handlers now live in `SubagentCollaboration` and are
exposed through `collaborationToolContributions(...)`; that is the reference
shape. An owning domain or command-family module binds its handlers to the Turn
context and contributes them. The target `ToolRuntime` only aggregates those
contributions, matches them to the canonical registry, applies configuration and
scope filters, and rejects identity or schema collisions. Browser preparation,
execution, projection, capability evaluation, and lifecycle hooks never branch
inside `ToolRuntime`.

The Tenon-owned kernel remains the tool runner. A contributed `AgentTool` may
attach a `ToolExecutionContract`; a generic default contract adapts existing
tools without changing their behavior. The Browser Pilot command-family module
contributes its own prepared direct-`bash` handler and specialized contract to
the Turn-scoped command router. The local-command module composes command-family
handlers into the one canonical `bash` contribution; it does not absorb Browser
policy or execution ownership.

```text
domain/command module contributes AgentTool handler
  -> ToolRuntime assembles the effective canonical catalog
  -> native kernel tool runner receives a model tool call
  -> ToolExecutionContract.prepare
       -> transient execution state
       -> durable arguments
       -> durable capability intent
       -> transient safety effects and execution policy
  -> ToolExecutionAdapter decides effects
       -> enforce the non-user-configurable safety floor
       -> evaluate explicit user blocks
  -> emit tool_execution_start with durable arguments, intent, and decision
       -> PiEventNormalizer records the existing Item kind
       -> executionObserver records the diagnostic execution start
  -> ToolExecutionAdapter emits extension onToolStarted from durable arguments
  -> execute transient input
       -> project every raw update before forwarding it
       -> keep transient updates in memory; emit only durable updates
  -> project model result and durable result independently
  -> ToolExecutionAdapter emits extension onToolCompleted from durable arguments/result
  -> emit tool_execution_end with the durable result
       -> PiEventNormalizer completes the Item
       -> executionObserver records the diagnostic execution completion
  -> append the model result only to the active kernel transcript
```

Extend the internal tool-runner port with four operations:

```ts
interface ToolExecutionContract<TPrepared, TUpdate = unknown> {
  prepare(
    args: unknown,
    context: ToolPreparationContext,
  ): PreparedToolExecution<TPrepared>;
  execute(
    prepared: TPrepared,
    signal: AbortSignal | undefined,
    onUpdate: (update: TUpdate) => void,
  ): Promise<unknown>;
  projectUpdate(
    call: PreparedToolExecution<TPrepared>,
    update: TUpdate,
  ): { transientUpdate: AgentToolResult | null; durableUpdate: JsonValue | null };
  projectOutcome(
    call: PreparedToolExecution<TPrepared>,
    outcome: ToolExecutionOutcome,
  ): { modelResult: AgentToolResult; durableResult: JsonValue };
}
```

Every prepared call carries immutable, separately typed fields. `execution` is
raw in-memory state used only by the contributed handler.
`durableArguments` is the sole argument source for kernel events, Items,
extension hooks, audit, history, Memory, diagnostics, payloads, and logs.
`capabilityIntent` is the sanitized durable descriptor/marker projection used by
audit and Items. `safetyEffects` carries transient host evidence, including
canonical output paths, used by the new `decide(effect)` path but never
persisted. Optional execution policy remains owned by the concrete handler:
process-backed calls use `ProcessExecutionPolicy`; other tools do not carry
process fields.

The durable intent contains precomputed `commandActions`, classification state,
and explanation copy. For an unclassified Browser call, its Item projection
adds a `CommandAction` whose `kind` is
`unclassified, worst-case classified` and whose `command` is the sanitized
durable command, alongside the action entries. The capability audit stores the
same classification plus the plain-language worst-case explanation. This uses
the existing `CommandAction` shape and requires no new Thread Item field.

`ToolExecutionAdapter` becomes the sole owner of the prepared lifecycle around a
contributed handler. Today `ToolRuntime.instrumentTool` wraps every `execute` to
evaluate capability blocks, establish mutation causation, attach capability
audit, and fire extension hooks. The implementation deletes that wrapper and
moves those duties into the generic adapter invoked by the kernel; it does not
leave a compatibility wrapper behind. The adapter receives capability policy,
mutation causation, and extension callbacks through `ToolPreparationContext`.
`onToolStarted` receives only `durableArguments`; `onToolCompleted` receives the
same durable arguments plus `durableResult` or a stable safe error. Allowed,
blocked, thrown, cancelled, and projection-failure paths each fire exactly one
start/completion pair, so hooks neither duplicate nor observe raw Browser argv,
credentials, partial output, or model-only results.

`PiEventNormalizer` remains the sole translator from the existing kernel event
stream into canonical tool Items, including the explicit no-Item policy for
controller calls such as `update_plan`. Its `executionObserver` continues to
feed `TurnDiagnosticsCollector.captureToolExecutionStarted/Completed`, so Model
Interactions retains the same tool-execution batches, Item IDs, timing, status,
and adjacent Provider Call links established by #444. The start event carries a
durable execution envelope containing `durableArguments`, `capabilityIntent`,
and the normalized allow/deny decision. `PiEventNormalizer` uses that envelope
to create the Item and populate `commandActions`, including the unclassified
marker, while the final structured result carries the same decision in
`capabilityAudit`. Update events carry only `durableUpdate`; end events carry
only `durableResult` and stable error state. The normalizer retains the start
envelope by call ID until completion, so intent reaches history without being
reparsed from a result.

Raw updates stay inside the contract callback until `projectUpdate` returns.
The kernel routes `transientUpdate` only to the active in-memory consumer and
emits `durableUpdate` only when it is non-null. The default adapter preserves
existing non-sensitive streaming behavior; Browser contracts redact or suppress
updates. A projection failure discards the raw update and emits at most one
constant safe update. Raw transient values never reach the normalizer,
diagnostics, hooks, or event stream.

This is not a second diagnostics pipeline. `PiTurnExecutor` still creates the
collector, subscribes it and the normalizer to `NativeAgentRuntime`, and wires
the pre-adapter context, post-adapter payload, and response hooks through
`PiModelGateway`. `TurnLifecycle` remains responsible for executing the Turn,
persisting and late-refreshing the inspection-only diagnostics payload, and
installing its reference on the terminal Turn. `ModelGateway` remains a
provider-transport port and receives no Browser tool-execution responsibility.

Preparation and the complete safety-floor/user-block decision must finish before
Item creation, extension hooks, or process spawn. A grammar, preparation, or
decision failure emits a start/end pair and matching extension lifecycle pair
containing only a constant safe rejection projection; it never invokes the
executor.
`ToolExecutionOutcome` represents both returned results and thrown errors, so
one projector governs every completion path.
Outcome projection must finish before a result is returned to the model or
persisted. If it fails after execution, the raw result is discarded and both
model and durable surfaces receive a constant `unknown_outcome` result with
inspect-before-retry guidance.

The full provider-facing catalog is governed by
`tests/fixtures/agentToolCatalogStability.test.ts`. Any change to tool name,
canonical order, description, or JSON schema must be an intentional reviewed
snapshot delta in the same PR. Browser Control adds no native Browser model
tool; the expected catalog delta is limited to the approved optional
`bash.stdin` schema and corresponding `bash` guidance. Every other catalog byte
must remain stable, and the existing deliberate reorder and description
mutations must continue to fail the judge.

### Command Execution Router

Refactor `bash` around a `CommandExecutionRouter` instead of adding Browser
conditionals to the existing monolithic tool. A command provider owns matching,
preparation, execution, result projection, and process policy for one command
family.

```text
bash
  -> CommandExecutionRouter
       -> BrowserPilotCommandProvider
       -> DefaultShellCommandProvider
```

The default provider preserves ordinary shell execution, background tasks, and
full-output capture. The Browser Pilot provider is selected only for one direct
`bp` invocation and never launches a shell. It executes the verified binary by
absolute path with argv, a private environment, bounded stdout/stderr, and no
generic overflow file.

The provider contract is intentionally reusable for future bundled command
families that need stronger identity, environment, capability, persistence, or
cancellation guarantees. Browser-specific code remains under one module rather
than spreading across `agentLocalTools`, `agentCapabilities`,
`PiTurnExecutor`, and packaging code.

### Direct Command Grammar

`BrowserPilotCommandProvider` accepts a deliberately small direct-command
language, parsed by a dedicated state-machine parser rather than regular
expressions or a partial Browser Pilot CLI parser. The grammar handles words,
whitespace, single quotes, double quotes, and backslash escapes, then produces
argv that is passed directly to the executable.

It accepts:

- `bp --version` and help-only forms; and
- one `bp [global-options] <command> ...` invocation, including a `net`
  subcommand.

It rejects before process spawn:

- environment assignments, unquoted shell expansion, command substitution,
  heredocs, redirection, pipelines, control operators, background execution,
  multiple commands, or unquoted newlines;
- alternate executable paths and aliases;
- caller-supplied `--client-key` or `--human`;
- on an unclassified command, any output-like flag that the pinned destination
  rules cannot recognize and canonicalize; and
- `run_in_background: true`.

Quoted arguments are literal argv, not shell source. They may contain dollar
signs, shell metacharacters, and newlines, so direct argument workflows do not
lose expressiveness.

The generic `bash` schema also gains an optional bounded `stdin` field for
foreground commands. `ProcessExecutionPolicy` writes those bytes directly to
the child process and closes stdin; it never constructs a pipe command or runs
an input-producing shell process. Stdin is always transient: durable arguments
record only its presence and bounded byte count, and sensitive providers add
its content to their taint set.

`BrowserPilotCommandProvider` accepts `bp eval` with either one expression argv
or `bash.stdin`, never both. Complex JavaScript therefore follows Browser
Pilot's published stdin contract without sending `echo ... | bp eval` through a
shell. The Browser Pilot host note and `bash` description teach this exact
Tenon transport. A pipeline attempt reaches the non-forwarding facade and
returns the same corrective guidance.

The parser does not generally validate Browser Pilot's command-specific flags,
values, or catalog membership; the CLI remains authoritative for those. It
extracts only global structural options, command/subcommand identity, and file
destinations that Tenon must constrain. A structurally valid direct `bp` command
is eligible for the Browser provider even when its command or `net` subcommand
has no pinned classification entry.

Output containment is the one command-flag admission exception. The grammar
splits long-option names into normalized segments and treats `out`, `output`,
`save`, `download`, `export`, `destination`, `dest`, `path`, `file`,
`directory`, and `dir` as output-like segments. Known destination flags use the
pinned command rules below. On an unclassified command, an output-like flag not
covered by those rules returns a stable `unrecognized_output_path` rejection
before capability evaluation or spawn. This conservative structural predicate
is not a command-catalog allowlist: unclassified commands without such a flag
continue to the worst-case effect decision, and unsupported commands still use
the pinned CLI as the authoritative error source.

The Agent `PATH` contains a Tenon-owned non-forwarding `bp` facade so
`command -v bp` works as the upstream skill expects. Structurally valid direct
calls are intercepted and executed by the provider. If a compound shell command
reaches the facade, it returns a fixed machine-readable error and never forwards
to the raw binary. The verified raw binary is not added to `PATH`.

Full Access is not an OS sandbox: a hostile same-user process may search
application resources. The supported Agent route is nevertheless deterministic,
classified, auditable, and incapable of accidentally bypassing Browser blocks
through ordinary shell composition.

### Browser Pilot Provider

The provider prepares one immutable `BrowserPilotCall` containing:

- parsed command, optional `net` subcommand, and classification state;
- transient argv and optional stdin, including free-form text and credentials;
- a taint set derived from every free-form argument;
- the resolved verified executable;
- a host-generated Thread client key and Turn output directory;
- normalized Browser capability descriptors;
- host safety effects with transient output-containment evidence;
- a sanitized durable command rendering; and
- a foreground process policy aligned with Browser Pilot's deadline.

The durable command keeps only command identity, structural flags, bounded
numeric refs or indices, and placeholders such as `<text>`, `<url>`, `<path>`,
`<selector>`, `<credential>`, or `<expression>`. It never stores a free-form
argument merely because that value does not look secret.

The transient model result preserves the bounded structured data needed to
continue the active Turn, including stable errors and task-relevant browser
observations, after removing credential fields and direct echoes of tainted
inputs. The durable result is built independently from an allowlist:
completion state, stable error code, retryability, safe remediation code,
sanitized action summary, and file MIME/size/dimensions. It excludes arbitrary
stdout/stderr, page text, URLs, Profile identity, cookies, headers, bodies,
selectors, refs, target IDs, command IDs, file paths, and upstream error text.

### Capability Model

Add Browser-specific action kinds to the shared catalog:

| Action kind | Meaning |
|---|---|
| `browser.read` | Browser discovery, inventory, recovery inspection, observation, search, waits, and capture |
| `browser.control` | Connection, Profile/target/frame selection, navigation, scrolling, cancellation, and tab lifecycle |
| `browser.external_action` | Page input/action, upload, dialog response, auth change, script execution, and network mutation |
| `browser.sensitive_read` | Any result that may expose browser, account, page, file, cookie, command, or network context |
| `browser.developer` | JavaScript evaluation and network inspection/interception |

This implementation also introduces a host-only `ToolSafetyEffect` vocabulary;
its first required kind is `filesystem.write`. Safety effects are not model-tool
action kinds, user block settings, or approval prompts. They carry the transient
evidence needed to enforce host invariants. A Browser `filesystem.write` effect
contains the canonical Turn output root, every recognized explicit destination,
and whether the pinned `BROWSER_PILOT_OUTPUT_DIR` contract governs default
output. Known commands attach the effect only when they may write. Every
unclassified command attaches it as part of worst-case classification, even
when no output flag is present.

Add `decide(effect)` as a new host decision stage in
`agentCapabilities.ts`; it does not exist in the current runtime. Its order is
fixed:

1. A non-user-configurable safety floor evaluates every `ToolSafetyEffect`. It
   denies an unknown effect kind, a `filesystem.write` effect without complete
   containment evidence, or any destination outside the canonical Turn output
   root. The unavailable decision uses source `safety_floor`, stable code
   `unsafe_filesystem_write`, and remediation that explains the contained
   output-root requirement.
2. If the safety floor allows, the existing explicit-block matcher evaluates
   normalized action descriptors and may return `user_blocked`.
3. Otherwise the call is allowed under Full Access.

Settings cannot weaken or bypass step 1. This is a narrow Browser-provider
admission invariant, not a general Agent filesystem sandbox or a per-operation
approval system. The Direct Command Grammar's
`unrecognized_output_path` rejection runs even earlier, so an unknown
output-like flag never reaches the decision stage with fabricated containment
evidence.

For a classified command, the provider supplies its precise applicable
descriptors and safety effects before execution. Every observation-bearing
result carries both `browser.read` and `browser.sensitive_read`, including
connect, page/content/capture inventory, recovery, and post-action page state.
Version/help and the fixed result of `disconnect` are the only classified calls
that do not carry sensitive read.

`browser.sensitive_read` remains allowed by default in Full Access and is
narrowed only by an explicit user block; it adds no approval prompt. The safety
floor does not independently deny sensitive reads. This intentionally lets
authenticated browser content reach the active model when the capability is not
blocked.

Browser Pilot cannot reliably distinguish ordinary interaction from a message,
form submission, purchase, or other business effect. Until trustworthy semantic
evidence exists, every `browser.external_action` call also carries the existing
`external.message.send` descriptor as a conservative potential-communication
guard. The audit summary states that the action *may* communicate externally;
it does not claim that every click actually sent a message. Either explicit
block denies the call before spawn. Default Full Access still exposes the
complete Browser Pilot surface, with no per-operation approval.

Catalog membership is not an admission gate. An unclassified command or `net`
subcommand receives all five Browser action kinds as its worst-case
classification, plus `external.message.send` because the set includes
`browser.external_action`, and the host-only `filesystem.write` safety effect.
The complete worst-case set goes through the same new `decide(effect)` path as a
known command. If the safety floor and all matching explicit blocks allow it,
Full Access runs the pinned executable; an unsupported command then returns the
CLI's own structured error.

Capability audit and `commandActions` are derived only from that normalized
intent and the sanitized durable command. Unclassified calls carry the durable
marker `unclassified, worst-case classified` and a plain-language explanation
that Tenon treated the command as capable of every Browser action and a
filesystem write. The audit records the safety-floor result, user-block result,
and final decision source without persisting canonical paths. A denial explains
either the host containment invariant or the matching user rule without
exposing transient arguments. An unclassified direct call never falls back to
`shell.unknown` or the default shell provider.

The pinned classification catalog remains the precision map for known commands,
not an allowlist. Binary version and digest pinning remain unchanged supply-chain
requirements. If the pinned `bp` binary does not support a structurally valid
command, its structured CLI error is the authoritative failure.

### Identity And Lifecycle

One independent Tenon Thread maps to one stable Browser Pilot client namespace.
Root Threads, child Threads, forks, and isolated-skill Threads receive distinct
keys; repeated Turns in one Thread reuse the same key.

```text
tenon.<base64url(sha256(installationId + ":" + thread.id))>
```

The key is bounded, contains no personal data, is not authentication material,
and is injected only into the Browser Pilot process. It never appears in model
input, Items, hooks, logs, or diagnostics.

Turn completion, Thread archive, and app exit preserve Browser Pilot state for
later Turns and other clients. After active Turns stop, Thread deletion first
persists an idempotent cleanup intent for every deleted descendant, then removes
the local Thread records and drains `bp disconnect` asynchronously. Cleanup uses
the same verified executable and derived key, closes only that namespace's
managed tabs, and never blocks local deletion on browser availability. A small
host-owned retry journal resumes incomplete cleanup at startup; it stores only
derived client keys and retry metadata, never browser content.

Tenon does not create or manage Browser Pilot Workspaces or Leases, and it does
not stop a shared Broker.

### Turn-Owned Files

Each Turn receives a private output root through the existing scratch lifecycle:

```text
<agentScratchRoot>/browser-pilot/<thread-id>/<turn-id>/
```

The provider creates and canonicalizes the directory before execution and
injects it as `BROWSER_PILOT_OUTPUT_DIR`. Explicit screenshot, PDF, download,
and saved-body destinations must resolve within that root; traversal, symlink
escape, and alternate absolute destinations fail before process spawn. Known
destination flags contribute canonical targets to the `filesystem.write` safety
effect. For an unclassified command, absence of an explicit destination is
contained by the injected output root; any unrecognized output-like flag fails
at grammar admission rather than trusting the CLI to choose a path.

Browser Pilot returns absolute file metadata to the active model result. The
Agent reads images, PDFs, and other files through Tenon's existing `file_read`
capability. Generated files follow the normal scratch TTL and do not become
durable Thread resources automatically. Upload source paths remain transient
Full Access inputs and never enter the durable Browser Item.

### Distribution And Skill

Maintain one checked-in Browser Pilot distribution manifest for `v0.5.0`
containing the release-index digest, platform/architecture asset URL, archive
digest, expected executable digest, plugin archive and skill digests, license
inventory, and compatibility range.

A deterministic sync script uses a content-addressed local cache or downloads
only the pinned release during development/build preparation, verifies every
digest and archive path, stages the native executable plus complete upstream
plugin skill under `build/generated`, and sets executable permissions. Runtime
code never downloads or repairs assets. Electron Builder copies the verified
generated directory with `extraResources`.

Deferred beyond 1.0: a signed-component inventory updater is the established
evolution path only if the cadence of Browser Pilot releases proves manual
manifest updates to be a recurring pain point. This feature does not build that
updater; the checked-in pin and deterministic verification remain authoritative.

Packaged Tenon resolves the executable only below `process.resourcesPath`.
Source runs accept only the verified generated asset or one explicit absolute
development override whose version and digest are checked. Missing, mismatched,
unsupported, or partially staged assets make Browser Control unavailable as one
unit. The initial release supports only Browser Pilot's published Apple Silicon
macOS asset. Intel macOS is unsupported as an accepted launch constraint, not a
missing fallback to discover or download at runtime.

Bundle the exact complete upstream `browser-pilot` skill directory, including
`SKILL.md`, `compatibility.json`, `agents/openai.yaml`, and all references.
Browser Pilot remains authoritative for command usage, setup, browser operation,
file handling, waiting, and recovery. A short host-owned note adds only Tenon
transport facts: the executable and environment are already provided, commands
must use the direct `bp` route, and stdin workflows use `bash.stdin` instead of
shell composition. It does not duplicate or fork the upstream command manual.

Built-in skill registration gains a host-owned, per-Turn availability predicate
that is separate from upstream frontmatter and `allowed-tools`. The Browser
Pilot predicate requires:

- the matching verified CLI distribution;
- `bash` in the effective Turn tool catalog; and
- at least one non-metadata Browser Pilot catalog command whose complete action
  descriptor set survives the effective explicit blocks.

Apply the same predicate to model-visible skill listing, direct `skill`
invocation, restored/compacted skill state, and active instruction loading. A
predicate failure makes Browser Pilot absent rather than advertising guidance
that the Turn cannot execute. Re-evaluate it for every root, child, forked, and
isolated-skill Turn because parent ceilings and Role tool catalogs differ.

### User Experience

- Browser Pilot is included with Tenon; the user installs no separate CLI,
  extension, SDK, or MCP server.
- The Agent uses `bp browsers` for passive setup inspection. It runs
  `bp connect` only after `browser_disconnected` or an explicit user request.
- Chrome owns remote-debugging enablement and the visible Allow dialog. First
  authorization remains conversation-only: the Agent reports structured
  remediation and waits instead of looping or claiming authorization succeeded.
  Tenon adds no onboarding card or Settings surface for this flow.
- The initial release is available only on Apple Silicon macOS; Intel macOS is
  not supported.
- When several live Profiles match, the Agent inventories representative tabs,
  uses `profiles --identify` only when account-aware labels are necessary, and
  asks the user only when the intended Profile remains ambiguous.
- Browser Pilot may control eligible user-opened tabs, but the Agent prefers a
  managed tab for independent work and leaves user tabs open unless the task
  explicitly requires closing one.
- Tenon adds no duplicate browser window, toolbar, per-operation approval, or
  settings UI in this feature.

### Process Policy, Cancellation, And Recovery

Generalize the process runner with an explicit `ProcessExecutionPolicy` rather
than adding Browser-specific timers:

- optional auto-background threshold;
- hard deadline;
- graceful termination signal and grace period;
- bounded stdout/stderr limits;
- overflow persistence policy; and
- private environment keys.

The default shell provider keeps current behavior. Browser Pilot sets no
auto-background threshold, disables overflow persistence, and gives `SIGTERM`
at least Browser Pilot's two-second cancellation fallback plus cleanup margin
before `SIGKILL`.

The effective outer deadline is greater than the parsed Browser Pilot
`--timeout` by the cancellation grace. A caller-provided bash timeout that is
too short, or a Browser Pilot timeout that cannot fit inside the bash maximum,
is rejected before spawn. Tenon never retries Browser commands automatically.

The active model receives Browser Pilot's stable `code`, `retryable`, bounded
`context`, and `remediation` fields. The skill owns recovery behavior:

- `browser_disconnected` permits one deliberate `connect`;
- `target_busy` means wait or choose another tab, never steal it;
- stale refs/Profile/frame/target state requires fresh inventory;
- `wait_timeout` does not prove the underlying action failed;
- `unknown_outcome`, `action_not_verified`, interruption, or a lost result
  requires `status`/`command` plus current-state inspection before retry; and
- `--request-id` is stable only for one intended operation.

### Persistence Matrix

| Surface | Browser input | Browser result |
|---|---|---|
| Process | Raw argv plus private host environment | Raw bounded stdout/stderr until projection |
| Active model Turn | Original model arguments | Sanitized structured result needed for continuation |
| Item and `commandActions` | Sanitized durable command and capability intent | Allowlisted durable outcome |
| Extension hooks and audit | Durable arguments only | Durable result only |
| Rollout/history/fork/Memory | Durable Item only | Durable Item only |
| `outputRef` and diagnostics | No raw input | Durable result only; no overflow fallback |

Information intentionally retained from a browser task must be stated by the
Agent in its normal response or explicitly written to an authorized file. Tenon
does not silently retain authenticated page dumps as tool history.

### Implementation Ownership

The implementation should create cohesive modules rather than enlarge existing
catch-all files:

```text
src/main/agent/runtime/toolExecution/
  ToolExecutionContract.ts
  ToolExecutionAdapter.ts
  CommandExecutionRouter.ts
  ProcessExecutionPolicy.ts

src/main/agent/browserPilot/
  BrowserPilotDistribution.ts
  BrowserPilotCommandGrammar.ts
  BrowserPilotCommandCatalog.ts
  BrowserPilotCommandProvider.ts
  BrowserPilotProjection.ts
  BrowserPilotLifecycle.ts
```

The Browser Pilot command-family owner binds its Turn-scoped provider and
contributes its prepared direct-`bash` handler to the router, following the #456
owner-contributes-handler pattern. The default shell provider contributes its
sibling handler; the local-command module composes the router into one canonical
`bash` `AgentTool` contribution. `agentCapabilities.ts` consumes prepared
capability intent instead of reparsing Browser commands. As part of this change,
`ToolRuntime.instrumentTool` is removed: capability decisions, mutation
causation, audit attachment, and extension lifecycle notification move together
to `ToolExecutionAdapter`. `ToolRuntime.ts` therefore becomes assembly-only
rather than being described as if it already were.

The optional execution contract extends the Tenon-owned `AgentTool`/kernel
runner port in `runtime/kernel/types.ts` and the tool-runner code currently in
`runtime/kernel/kernel.ts`; it does not create a parallel runner in
`ToolRuntime`. `PiEventNormalizer` keeps tool Item translation and its
diagnostics observer unchanged, while the kernel events it consumes carry only
durable projections. `PiTurnExecutor` keeps the #444 collector and #445
`NativeAgentRuntime`/`PiModelGateway` wiring.

In the post-#451 Thread layout, `TurnLifecycle` supplies Thread/Turn execution
context and owns diagnostics finalization, `ThreadCatalogOps` owns the deletion
path that schedules Browser namespace cleanup, and `ThreadResourceOps` remains
the owner of Thread payload/reference cleanup. `ThreadService` only composes and
forwards those owners; Browser lifecycle state does not move back into the
facade.

The same PR updates:

- `src/core/agent/tools.ts` for Browser action kinds;
- `src/core/agent/extensions.ts` comments/contracts to state lifecycle payloads
  are durable projections;
- `src/main/agent/capabilities/agentCapabilities.ts` for the new ordered
  safety-floor/user-block decision and host safety effects;
- `src/main/agent/runtime/ToolRuntime.ts` to remove `instrumentTool` and leave
  only contribution assembly, registry validation, configuration, and scope
  filtering;
- `src/main/agent/runtime/kernel/types.ts` and `kernel.ts` for the prepared
  contract, durable intent/decision event envelope, and projected updates;
- `src/main/agent/runtime/PiTurnExecutor.ts` so `PiEventNormalizer` projects the
  durable intent into `commandActions` without changing the #444 diagnostics
  observer chain;
- `docs/spec/agent-tool-design.md` for prepared execution and Browser Control;
- `docs/spec/agent-tool-permissions.md` for Browser descriptors and blocks;
- `docs/spec/agent-integration.md` for identity, lifecycle, files, and recovery;
- `docs/spec/agent-skills.md` for atomic built-in skill/CLI availability; and
- packaging documentation for the pinned distribution contract.

No URL Preview spec gains a Browser Control dependency.

## Validation

- Contract-test the default prepared-execution adapter for every existing tool
  Item type and preserve the native-kernel Item/event golden. Prove
  `PiEventNormalizer` remains the sole tool Item translator and its
  `executionObserver` still produces identical Model Interactions batch links,
  Item IDs, timings, and terminal statuses. Assert `ToolRuntime.instrumentTool`
  is gone and capability evaluation occurs exactly once before the start event.
- Prove preparation and decision happen before Item creation, hooks, audit,
  logs, or spawn. The start event must transport durable arguments, intent, and
  decision into `commandActions`/`capabilityAudit`; update/end events carry only
  durable projections. A projection failure after spawn returns one constant
  `unknown_outcome` without exposing raw output.
- Stream sensitive canaries through `projectUpdate`; prove the raw update is
  never emitted or passed to an extension, transient updates remain in-memory,
  durable updates are independently redacted or suppressed, and the default
  adapter preserves every existing non-sensitive update sequence.
- For allow, safety-floor deny, user-block deny, throw, cancellation, and
  projection failure, prove `ToolExecutionAdapter` establishes mutation
  causation and fires exactly one extension start/completion pair using only the
  durable arguments and result.
- Run `agentToolCatalogStability` against the complete canonical catalog. Review
  and snapshot only the intended `bash.stdin`/guidance byte delta; prove tool
  names, canonical order, and every unrelated description/schema byte remain
  unchanged, and re-run both deliberate judge mutations.
- Use canaries across typed text, credentials, upload paths, headers, bodies,
  URLs, selectors, Profile labels, cookies, page content, eval source, refs, and
  command IDs; prove they never enter any durable surface in the persistence
  matrix.
- Test the direct-command grammar exhaustively, including quoting and every
  rejected shell construct; prove compound commands can reach only the
  non-forwarding facade.
- Prove each recognized output flag canonicalizes inside the Turn root and that
  an unclassified command carrying `--out`, `--output-path`, `--save-to`, or any
  other output-like unknown flag returns `unrecognized_output_path` through the
  safe rejection lifecycle before capability evaluation or process spawn.
- Prove the non-user-configurable safety floor runs before user blocks, settings
  cannot disable it, unknown safety effects fail closed, and
  `filesystem.write` without complete in-root containment evidence returns
  `unsafe_filesystem_write` before spawn.
- Compare the pinned command/subcommand catalog with `bp --help` and
  `bp net --help`; known entries retain exact mappings, while absent entries
  receive all five Browser descriptors, `external.message.send`, and the
  `filesystem.write` safety effect, then execute only after the new
  `decide(effect)` stage.
- Prove an unclassified command carries the durable
  `unclassified, worst-case classified` marker and understandable explanation,
  that the start-event intent produces the same marker in the persisted Item,
  every matching Browser or external-message block denies it before spawn, an
  unblocked and safely contained call reaches only the verified `bp` binary,
  and an unsupported command returns `bp`'s structured error.
- Verify each Browser action kind independently blocks its mapped commands and
  that `Action(external.message.send)` conservatively blocks every ambiguous
  `browser.external_action` before spawn while leaving Browser reads and control
  operations available.
- Prove bounded `bash.stdin` reaches a foreground child without shell
  composition, is never persisted, and executes complex `bp eval` input while
  rejecting an expression-plus-stdin ambiguity and ordinary pipeline attempts.
- Prove Browser Pilot is omitted from listing, direct invocation, restore, and
  active instructions whenever its Turn availability predicate fails, across
  root, child, forked, and isolated-skill Threads.
- Prove one Thread reuses state across Turns while root, child, forked, and
  isolated-skill Threads receive distinct client namespaces and `target_busy`
  protects one physical tab.
- Prove Turn completion, archive, and app exit preserve state; Thread deletion
  cleans only managed tabs, journals transient cleanup failure, and retries
  idempotently without touching user tabs.
- Prove `wait` and delayed `connect` remain foreground beyond 15 seconds;
  deadline derivation, `SIGTERM` grace, `SIGKILL` escalation, and uncertain
  recovery match Browser Pilot semantics.
- Prove every Turn receives a distinct canonical output root, explicit paths
  cannot escape through traversal or symlinks, default outputs remain contained
  for unclassified calls without path flags, and generated
  image/PDF/download results are consumable through `file_read` and pruned by
  scratch policy.
- Verify release index, checksums, archive layout, executable bit, architecture,
  `bp --version`, compatibility range, license inventory, exact skill resources,
  source resolution, packaged resolution, and atomic unavailability.
- Run a real-browser smoke workflow covering setup inspection, deliberate
  connect, Profile/tab selection, observation, a disposable verified action,
  wait, screenshot, uncertain-command inspection, and managed-tab cleanup.
- Confirm URL Preview is never discovered or controlled by Browser Pilot.
- Run `bun run typecheck`, `bun run test:core`, relevant E2E tests,
  `bun run app:build`, packaged asset verification, `bun run docs:check`, and
  `git diff --check`.

## Risks

- Extending the native kernel's tool-runner port to separate transient model
  results from durable event results is a broad runtime change. The default
  adapter, removal of `ToolRuntime.instrumentTool`, extension lifecycle tests,
  Item/event golden, Turn diagnostics lifecycle suite, and full catalog
  byte-stability judge must remain green before Browser Pilot tests are
  considered.
- **Accepted sensitive-content risk:** Full Access allows
  `browser.sensitive_read` by default, so authenticated page content is
  intentionally available to the active model unless the user explicitly
  blocks that action. Durable projection prevents silent raw retention but
  cannot remove content the Agent deliberately includes in its response or
  writes to a file.
- The conservative `external.message.send` attachment intentionally blocks
  some non-messaging browser actions for users who configured that explicit
  block. This is preferable to silently bypassing an existing semantic block
  until Browser Pilot can provide trustworthy business-action evidence.
- Browser Pilot's public surface is CLI-only and its command inventory is not a
  permanent native manifest. Every version bump requires a coordinated catalog,
  projection, skill, asset, checksum, and compatibility review.
- The output-like flag predicate deliberately prefers a false-positive admission
  rejection over an uncontained write when a new CLI flag is ambiguous. A
  future pinned catalog update can classify that flag precisely; settings cannot
  bypass the rejection or the safety floor.
- Browser authorization depends on supported Chrome remote-debugging UI and a
  user Allow action Tenon cannot complete. Conversation-only remediation may be
  less discoverable than onboarding UI; that tradeoff is accepted for launch.
- Full Access cannot contain a hostile local process that searches packaged
  resources; the command provider secures Tenon's supported route, not the
  entire user account.
- Apple Silicon macOS is the only launch platform. Intel macOS is explicitly
  unsupported until a later release changes that accepted product constraint.

## Open Questions

- Should a later, separate product change add a Browser status/reset surface in
  Settings after CLI-only usage is validated?

## Subtasks

- Extend contributed handlers and the native kernel runner around
  `ToolExecutionContract` in the same PR, preserving normalizer Item ownership,
  Turn diagnostics capture, existing tool behavior, and all unrelated catalog
  bytes; remove `ToolRuntime.instrumentTool` and move its lifecycle duties to
  `ToolExecutionAdapter`.
- Add the durable intent/decision event envelope, projected update path, host
  `ToolSafetyEffect` vocabulary, ordered `decide(effect)` stage, and
  fail-closed output-path admission.
- Add `CommandExecutionRouter`, bounded transient `bash.stdin`, the default
  shell provider, and reusable process policies.
- Add Browser action kinds and the complete Browser Pilot command provider,
  grammar, catalog, projections, identity, files, lifecycle, and cleanup journal.
- Add deterministic Browser Pilot 0.5 distribution staging, the exact built-in
  skill, its host transport note, and per-Turn availability predicate.
- Update current specs and packaging documentation.
- Add lifecycle, privacy, grammar, capability, concurrency, recovery,
  cancellation, scratch, distribution, packaging, and real-browser tests.
