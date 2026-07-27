# Agent Browser Control

## Goal

Let an Agent use Browser Pilot to control the user's eligible Chrome tabs and
complete browser tasks with the user's existing Profiles, signed-in sessions,
cookies, extensions, and website state.

Tenon consumes Browser Pilot 0.5 through its only public Agent interface:

```text
Agent
  -> bundled Browser Pilot skill
  -> Tenon bash execution boundary
  -> short-lived bundled bp CLI
  -> shared per-user Browser Pilot Broker
  -> user's Chrome
```

Tenon does not create Browser Pilot-native model tools or a second browser
runtime. Browser Pilot owns browser discovery, authorization, Profile and tab
routing, target ownership, observations, actions, files, command recovery, and
Broker cleanup. Tenon owns reproducible distribution, effective Thread
capabilities, per-Agent identity, task files, cancellation compatibility,
audit, and the boundary between transient execution data and durable Thread
history.

URL Preview remains Tenon's internal quick-preview surface. It is not a Browser
Control target, does not share a Profile or controller with Browser Pilot, and
does not participate in Agent browser tasks.

## Non-goals

- Do not attach Electron CDP to URL Preview guests or make Preview panes
  controllable by the Agent.
- Do not reimplement Browser Pilot refs, target ownership, Profile routing,
  command recovery, Broker coordination, or browser cleanup inside Tenon.
- Do not expose Browser Pilot commands as Tenon-native model tools.
- Do not launch `browser-pilot bridge --stdio`, consume `tools/list`, add MCP,
  install a browser extension, import Browser Pilot private source modules, or
  add a persistent Browser Pilot client process.
- Do not search the user's `PATH`, run `npx`, install a package, or download or
  replace Browser Pilot while an Agent task is running.
- Do not let the model choose a Browser Pilot client key, raw executable path,
  output root, or human-output mode.
- Do not use URL Preview session data when the user's browser is unavailable or
  unauthorized.
- Do not infer whether an arbitrary click, keystroke, or script means "send a
  message", "submit a form", "make a purchase", or another business action.
- Do not persist Browser Pilot's private protocol identities or treat them as a
  Tenon lifecycle contract.

## Shape

This plan is one complete Browser Control feature in one PR. The PR builds the
A4 foundation before its consumer, but neither stage ships separately:

1. Add Browser action kinds and a generic execution-versus-durable-projection
   contract. It allows a tool call to use raw values transiently while Items,
   rollouts, extension hooks, history, Memory, diagnostics, and full-output
   storage receive only an independently constructed durable projection.
2. Build Browser Pilot 0.5 on that contract: package the executable and skill,
   add the classified direct-`bp` bash route, inject Thread/Turn context, and
   prove the complete user workflow.

The feature is complete only when a packaged Tenon Agent can discover the
skill, invoke the bundled CLI through `bash`, connect to the user's browser,
perform and verify a browser task, recover an uncertain command, consume a
file result, and leave unrelated user tabs untouched.

## Collision Result

- No open PR claims Browser Pilot packaging, the built-in Browser Pilot skill,
  or this plan.
- Draft PR #441 claims Agent context composition and canonical evidence
  admission. It currently publishes no file diff, but this PR must recheck and
  sequence any overlap in `PiTurnExecutor`, rollout, history, or evidence
  projection before editing those shared paths.
- `docs/plans/browser-extension-integration.md` remains restricted to future
  read-only URL Preview extraction and has no Browser Control dependency.
- This PR claims the shared action kinds, persistence projection, Browser Pilot
  packaging, and built-in skill as one complete feature. Foundation changes land
  earlier in its commit/build order but are not independently releasable.
- `docs/TASKS.md` and `CHANGELOG.md` remain main-agent-owned and are updated at
  the merge gate.

## Design

### Product Boundary

| Capability | URL Preview | Browser Control |
|---|---|---|
| Purpose | Quickly preview an HTTP(S) URL inside Tenon | Let an Agent complete tasks in the user's browser |
| Runtime | Sandboxed Electron webview | Short-lived `bp` CLI plus shared Browser Pilot Broker |
| Browser state | Tenon-owned `persist:url-preview` partition | User-owned Chrome Profiles and signed-in sessions |
| Agent access | None | Browser Pilot skill through classified Tenon `bash` |
| Targets | Visible Preview panes | Eligible user tabs and Browser Pilot-managed tabs |
| Lifecycle | Workspace preview lifecycle | Stable Browser Pilot client key per independent Thread |

Neither side discovers, adopts, or controls the other's targets. Opening the
same URL in both surfaces does not create shared identity, cookies, tabs, refs,
or permissions.

### Browser Pilot Public Contract

Browser Pilot 0.5 has one public Agent integration surface:

```text
skill -> existing shell/command runner -> bp CLI
```

The CLI process is short-lived. The compatible per-user Broker is shared and
long-lived implementation state. Tenon relies only on these published CLI
contracts:

- stable `BROWSER_PILOT_CLIENT_KEY` state isolation;
- JSON success and failure envelopes, stable error `code`, `retryable`,
  `context`, and `remediation` fields;
- `bp status`, `bp commands`, `bp command`, `bp cancel`, and `bp wait` for
  recovery without a persistent client;
- per-operation `--request-id` deduplication and `--timeout` deadlines;
- `BROWSER_PILOT_OUTPUT_DIR` and absolute file-result metadata;
- process-signal cancellation with `unknown_outcome` when a mutation may have
  reached Chrome; and
- `bp disconnect` releasing only the invoking Agent namespace and its managed
  tabs while preserving user-opened tabs.

Tenon does not bind to Browser Pilot's private Broker transport, Workspace,
Lease, event, Observation, Command, or Artifact schema. Opaque IDs returned by
the CLI are transient task values, not Tenon protocol identities.

### Baseline And Distribution

- Pin Browser Pilot CLI, skill, plugin metadata, compatibility metadata,
  release index, checksums, and licenses from the same `v0.5.0` release.
- The first packaged target uses the published Apple Silicon macOS native
  archive. Later targets may use only published and verified upstream assets;
  Intel macOS is unsupported.
- Stage the verified executable, complete skill directory, compatibility file,
  and licenses into a generated build directory and copy them with Electron
  Builder `extraResources`.
- Packaged Tenon resolves the raw executable only below
  `process.resourcesPath`. Source runs use a repository-generated asset or one
  explicit absolute development override. There is no global executable or
  runtime-download fallback.
- Fail the build on a missing asset, checksum mismatch, release-index mismatch,
  unsupported platform/architecture, missing executable bit, or a version other
  than the pinned release.
- Expose the Browser Pilot skill and supported `bp` route atomically. A build
  with either half missing exposes neither, so the Agent never attempts the
  skill's installation fallback.
- A future Browser Pilot bump is a reviewed distribution update. Its CLI help,
  command classifier conformance, skill compatibility range, recovery codes,
  assets, and checksums advance together.

### Classified Bash Route

The model-facing tool remains Tenon's existing `bash`; Browser Control does not
consume model-tool registry space. The standard command runner adds one
specialized direct-executable route:

```text
raw bash call
  -> recognize one direct bp invocation
  -> build transient execution envelope and durable projection
  -> evaluate Browser capabilities
  -> invoke the pinned executable with argv and private environment
  -> project its bounded JSON result
```

The recognizer is a shell-word lexer, not a Browser Pilot CLI parser. It does
only what Tenon needs to enforce its boundary:

- accept `bp --version`, help-only forms, and one direct `bp [global-options]
  <command> ...` invocation;
- identify the top-level command, and the `net` subcommand when applicable;
- reject environment assignments, redirection, pipelines, command
  substitution, background execution, multiple shell segments, alternate
  executable paths, `--client-key`, and `--human`;
- allow structural `--request-id` and `--timeout` values without assigning one
  static request ID to a Thread or Turn; and
- treat every other free-form argument as transient and potentially sensitive.

Browser Pilot remains responsible for validating its command-specific flags,
arguments, bounds, and error semantics. Tenon keeps only a pinned top-level
command classification table and fails closed on a command absent from that
table. A conformance test compares that inventory with pinned `bp --help` and
`bp net --help` output, so an upstream addition cannot silently fall through to
`shell.unknown`. `bp --help`, `bp help <command>`, and `bp <command> --help` are
metadata-only calls and cannot execute a Browser operation.

The Agent command environment resolves `bp` to a Tenon-owned shim for runtime
discovery, while supported direct invocations execute the verified raw binary
by absolute path. Compound shell attempts reach only the non-operational shim
and cannot invoke Browser Pilot through the supported path. Full Access is not
an OS sandbox; this boundary governs Tenon's supported Agent route rather than
claiming to contain a hostile same-user process that searches app resources.

### Thread Identity And Lifecycle

Each independent root, child, isolated-skill, or forked Thread receives a
unique, stable Browser Pilot client key. Repeated Turns in one Thread reuse it
so Browser Pilot can preserve selected Profile, target, frame, refs, auth,
network rules, downloads, and recent recovery state across short-lived CLI
processes.

The host derives a bounded key from Tenon's stable installation identity and
canonical `thread.id`, for example:

```text
tenon.<base64url(sha256(installationId + ":" + thread.id))>
```

The value contains no personal data or secret, never includes `turn.id`, never
appears in model input or durable Items, and is injected as
`BROWSER_PILOT_CLIENT_KEY` only for the direct `bp` process. Different Threads
therefore cannot accidentally share the default CLI namespace.

Tenon does not create, heartbeat, renew, or release Browser Pilot Leases. The
CLI and Broker own those internals. Turn completion and normal app exit do not
run `bp disconnect`; the Thread namespace remains available for later Turns and
the shared Broker remains available to other Agents. Thread deletion or an
explicit host-owned Browser reset runs `bp disconnect` once with that Thread's
key. Browser Pilot closes only that namespace's managed tabs and leaves
user-opened tabs alive.

### Turn Files

Browser state is Thread-scoped, while files produced for one Turn are
Turn-scoped. Before tool creation, Tenon creates:

```text
<agentScratchRoot>/browser-pilot/<thread-id>/<turn-id>/
```

The direct route injects the absolute app-owned directory as
`BROWSER_PILOT_OUTPUT_DIR`. Screenshot, PDF, download export, and saved network
body commands may omit a filename and use Browser Pilot's generated name.
Explicit output destinations must canonicalize inside the same directory;
escaping destinations fail before process spawn.

The CLI returns absolute path, MIME type, byte size, and image dimensions when
available. The Agent consumes the path through `file_read`, which owns image,
PDF, and other file projection. Browser output files follow normal agent-scratch
TTL and do not become Thread resources merely because Browser Pilot created
them. Upload and network-mock source files retain normal Full Access semantics,
but their source paths remain transient and are never copied into the Browser
Item projection.

### Execution And Durable Projection

Today `bash` records its raw command before execution and persists complete
output afterward. Browser Pilot commands can contain passwords, typed text,
headers, mock bodies, private paths, selectors, URLs, and authenticated page
content, so the feature's foundation stage must separate execution from persistence
before Browser Control ships.

For every recognized call the host creates an immutable in-memory envelope
before `item/started`, capability event publication, extension notification, or
logging:

```text
raw model input
  -> direct-command recognition
  -> transient argv + taint set
  -> independent durable input projection
  -> capability preflight
  -> raw process execution
  -> bounded JSON parse and transient result sanitization
  -> independent durable result projection
```

The projections have distinct authority:

- **Transient execution input** contains the original argv and host-injected
  environment. It is available only to capability evaluation and process spawn.
- **Transient model result** contains the bounded Browser Pilot JSON needed for
  the active Turn after credential fields and tainted input representations are
  removed. It may contain task-relevant page observations, but it is never used
  as a persistence payload.
- **Durable input projection** contains `bp`, the canonical command/subcommand,
  structural flags, bounded numeric refs/indices, action kinds, and placeholders
  for every free-form value.
- **Durable result projection** is constructed from an allowlist: completion
  state, stable error code, retryability, safe remediation code, file MIME/size/
  dimensions, and a redacted outcome summary. It does not copy arbitrary CLI
  stdout, page data, URLs, Profile identity, refs, target/command IDs, or error
  text.

Only the durable projections may reach `commandExecution`, `commandActions`,
rollout JSONL, history reconstruction, renderer notifications, forks,
extension hooks, Memory evidence, diagnostics, logs, or the content-addressed
store behind `outputRef`. History after Turn completion or application restart
is rebuilt from those projections. Information worth retaining is stated by the
Agent in its normal answer rather than silently retaining the full browser dump.

Raw stdout and stderr never use the generic bash overflow/full-output fallback.
If recognition, classification, input projection, or capability evaluation
fails, no Browser Pilot process starts and every surface receives one constant
redacted rejection. If JSON parsing or result sanitization fails after process
execution, the raw result is discarded and every visible and durable surface
receives one constant redacted `unknown_outcome` result with inspect-before-
retry guidance. Tenon never treats a projection failure as proof that an
external mutation failed or rolled back.

This execution-versus-persistence API is generic Agent infrastructure; Browser
Pilot is its first consumer. Browser-specific taint extraction and durable
projection remain in the Browser integration rather than entering Core types as
a private CLI protocol.

### Capability Classification And Audit

Raw `bp` currently falls through to `shell.unknown`, which makes browser effects
look local and bypasses Browser-specific explicit blocks. The interface
feature adds these action kinds:

| Action kind | Access | Browser Pilot command class |
|---|---|---|
| `browser.read` | read, external system | discovery, status/recovery inspection, inventory, observe, read, search, find, wait, capture |
| `browser.control` | control, external system | connect/disconnect, Profile/target selection, navigation, scroll, dropdown, tab/frame state, command cancellation |
| `browser.external_action` | write, external system | click, type, keyboard, press, select, upload, dialog response, auth changes, tab close, eval/network mutation |
| `browser.sensitive_read` | read, external system | every command whose success or failure can reveal browser, Profile, target, page, file, auth, cookie, command, or network context |
| `browser.developer` | control, external system | eval and network inspection/interception/modification |

Every recognized command receives all applicable descriptors before execution.
Any matching explicit block makes the call unavailable and records the same
descriptor and rule on the canonical `bash` Item. Audit descriptors are built
only from the durable input projection.

Browser Pilot cannot reliably determine the business meaning of arbitrary page
interaction. Every `browser.external_action` call therefore also receives the
existing `external.message.send` descriptor until Tenon has trustworthy
semantic evidence. This does not add an approval prompt and has no effect under
default Full Access. It conservatively blocks ambiguous outward browser
mutation only when the user explicitly configured the existing external-message
block. `Action(browser.external_action)` remains the broad Browser-specific
switch.

`browser.sensitive_read` applies before process spawn to `status`, command
recovery, Profile/tab/frame/dialog inventories, page observations, captures,
cookies, auth, eval, network data, and every action returning post-action page
state. Version/help-only calls and the fixed `{ "ok": true }` result of
`disconnect` are the only conformance-tested result projections that do not
carry it; `disconnect` still requires `browser.control` because it releases
Agent state and closes managed tabs. New or changed commands fail closed until
the pinned classification table and conformance fixture are reviewed.

### Skill Contract

Bundle the complete upstream `browser-pilot` skill directory from the pinned
release, including `compatibility.json`, `agents/openai.yaml`, and references.
Browser Pilot owns command usage, state recovery, and browser-operation
guidance; Tenon does not fork those instructions into its stable system prompt.

The runtime exposes the skill only when the pinned direct `bp` route is
available. A small host-owned integration note states that Tenon already
provides the executable, client identity, and output directory; the Agent must
not install Browser Pilot, pass `--client-key`, force `--human`, override host
environment, use raw executable paths, or wrap `bp` in compound shell syntax.
Complex eval source is passed as a direct argument because Tenon's supported
route does not accept the upstream stdin-pipeline example.

The upstream skill otherwise remains authoritative and teaches the Agent to:

- use Browser Pilot for real-browser state and interaction, while keeping
  simple public retrieval on `web_*`;
- inspect setup passively and call `bp connect` only after
  `browser_disconnected` or an explicit user request;
- resolve Profile and tab context before acting and prefer managed tabs for
  independent work;
- observe before action, refresh stale refs, and verify browser-visible results;
- use dedicated commands before eval and keep sensitive reads bounded;
- inspect `bp status` and command history before retrying uncertain mutations;
- leave user-owned tabs open unless the task explicitly requires closing one;
  and
- consume generated files through `file_read`.

### User Interaction And Authorization

- Tenon includes Browser Pilot; the user does not separately install a CLI,
  extension, SDK, or MCP server.
- `bp browsers` is passive. The first task requiring browser control may run
  `bp connect`; Chrome owns remote-debugging enablement and its Allow dialog.
- The Agent reports structured setup remediation and waits when Chrome requires
  user interaction. It does not loop connection attempts or claim success
  before authorization.
- One authorized endpoint can expose multiple live Chrome Profiles and all
  eligible tabs. Profile selection routes newly managed tabs and is not an
  access-control boundary for existing tabs.
- Two Threads may inspect inventory concurrently, but Browser Pilot serializes
  control per physical target. The second Agent receives `target_busy`; Tenon
  never steals or closes the other Agent's target.
- The first release adds no Tenon browser window, browser toolbar, duplicate
  approval dialog, or per-operation confirmation. A Settings diagnostics/status
  surface is a later product decision.

### Waiting, Cancellation, And Recovery

The CLI and upstream skill own browser recovery. Tenon preserves their typed
contract and does not translate English error text into control flow.

- The direct route requires JSON mode and preserves stable `code`, `retryable`,
  bounded `context`, and `remediation` fields in the transient model result.
- `browser_disconnected` permits one deliberate `bp connect`; authorization
  failure waits for the user rather than looping.
- `target_busy` causes the Agent to wait or choose another target, never steal
  the tab.
- `stale_ref`, Profile, frame, target, and connection invalidation cause fresh
  inventory and observation.
- `wait_timeout` means the condition was not observed; it does not prove the
  underlying operation failed.
- `unknown_outcome`, `action_not_verified`, interruption, or a lost shell result
  requires `bp status` and current page inspection before any mutation retry.
- `--request-id` identifies one intended operation. It is reused only when
  recovering that same operation and is never assigned once per Thread or Turn.
- `bp commands`, `bp command <id>`, and `bp cancel <id>` remain ordinary direct
  CLI calls under the same client key and capability boundary.

Tenon's generic bash runner currently auto-backgrounds most commands after 15
seconds. Recognized direct `bp` calls must never auto-background: `bp wait` and
`bp connect` need their foreground JSON result and Browser Pilot's signal-aware
cancellation path. The outer bash deadline must exceed the parsed Browser Pilot
`--timeout` by at least the CLI's two-second cancellation fallback plus process
cleanup margin. An explicitly shorter outer timeout is rejected during
preflight. Turn cancellation sends `SIGTERM` to the process group, waits for
Browser Pilot's best-effort command cancellation, and escalates only after that
grace period. No Browser command is automatically retried by Tenon.

### Specs And Documentation

The feature's foundation stage updates:

- `src/core/agent/tools.ts`: ratified Browser action kinds;
- `src/core/agent/extensions.ts`: lifecycle payloads are durable projections,
  never raw execution values;
- `src/core/agent/protocol.ts`: `commandExecution`, `commandActions`, and
  `outputRef` are persistence projections;
- `docs/spec/agent-tool-permissions.md`: Browser descriptor/block semantics and
  the conservative external-action mapping;
- `docs/spec/agent-tool-design.md`: the generic transient execution versus
  durable Item/result contract.

The same PR then updates current behavior in:

- `docs/spec/agent-integration.md`: Browser Control integration and lifecycle
  checklist;
- `docs/spec/agent-skills.md`: bundled Browser Pilot skill provenance and
  atomic availability;
- `docs/spec/agent-tool-design.md`: direct `bp` route, Thread identity, Turn
  files, timeout/cancellation, and projection behavior; and
- packaging documentation: pinned assets, release index, checksums, licenses,
  supported architectures, and the development override.

URL Preview specs remain exclusively about internal preview behavior.

## Validation

- Verify the release index and its checksum, archive checksum, licenses, executable
  bit, architecture, `bp --version`, complete skill resources, and compatibility
  range for the exact packaged release.
- Prove source and packaged Agents resolve `bp` to Tenon's supported route and
  that no global executable, `npx`, runtime install, alternate path, caller
  client key, caller output root, `--human`, or compound shell form is accepted.
- Compare the pinned top-level and network-subcommand classifier with
  `bp --help` and `bp net --help`; prove every unknown or changed command fails
  closed before Browser Pilot starts, while version/help-only calls remain
  metadata-only.
- Run repeated commands across Turns in one Thread and prove selected Profile,
  target, frame, refs, auth, network rules, downloads, and command recovery reuse
  the same client namespace.
- Run root and child Threads concurrently and prove distinct keys isolate state;
  controlling one physical user tab returns `target_busy` to the other rather
  than sharing refs or stealing control.
- Prove Turn completion and app exit do not disconnect shared state; Thread
  deletion releases only its namespace and managed tabs; all user tabs remain
  open.
- Prove `Action(browser.read)`, `Action(browser.control)`,
  `Action(browser.external_action)`, `Action(browser.sensitive_read)`,
  `Action(browser.developer)`, and the conservative
  `Action(external.message.send)` attachment block their mapped calls before
  process spawn.
- Use unique canary values for type/keyboard text, auth, dialog prompts, uploads,
  headers, mock bodies/files, URLs, Profile selectors, search terms, eval source,
  cookies, page text, refs, and command IDs. Prove raw values appear only in the
  bounded active execution/model path and never in Items, `commandActions`,
  rollout JSONL, history/replay, renderer notifications, forks, extension hooks,
  Memory evidence, diagnostics, logs, or `outputRef` storage.
- Make a fake CLI echo raw and encoded canaries in stdout, stderr, JSON details,
  errors, and oversized output. Prove the generic bash overflow path is disabled
  and no raw fallback file survives.
- Prove recognition, classification, projection, and capability failures do not
  spawn Browser Pilot and return one constant durable rejection.
- Force malformed JSON and sanitizer failure after a fake mutating process exits;
  prove it ran once, raw output is discarded, all surfaces receive the same
  `unknown_outcome`, and no automatic retry occurs.
- Prove `bp wait` and a delayed `bp connect` remain foreground past 15 seconds,
  outer timeout exceeds the Browser Pilot deadline, Turn cancellation reaches
  the CLI with `SIGTERM`, and uncertain mutation state remains recoverable with
  `bp status`/`bp command`.
- Prove each Turn receives a distinct private
  `BROWSER_PILOT_OUTPUT_DIR`; omitted filenames and in-root explicit filenames
  work; escaping destinations fail before spawn; generated images and PDFs are
  consumable through `file_read`; scratch pruning removes expired files.
- Verify skill discovery, atomic skill/CLI availability, and the host note that
  removes installation, environment override, raw path, human mode, and compound
  shell guidance without duplicating upstream operation/recovery instructions.
- Run a real-browser smoke workflow: passively inspect setup, connect when
  required, inventory Profiles/tabs, open a managed tab, observe/read, perform a
  disposable verified form action, wait for a browser-visible result, capture an
  image, inspect command recovery, and close only the managed tab.
- Confirm URL Preview receives no Browser Control attachment and a Thread without
  effective `bash`/Browser capability cannot discover or invoke the integration.
- Run Browser Pilot's distribution verification for the exact packaged asset,
  then Tenon typecheck, relevant Core tests, packaging verification, docs check,
  and diff check.

## Risks

- Conservative mapping of ambiguous browser interaction to
  `external.message.send` intentionally blocks more than actual messaging for a
  user who configured that explicit block.
- Allowing `browser.sensitive_read` means authenticated page content may enter
  the active model context and the Agent's explicit natural-language answer.
  Tenon prevents automatic raw tool persistence but does not claim to infer
  sensitivity from a site, URL, or business domain.
- Browser Pilot's public interface is intentionally CLI-only and no longer
  publishes a permanent native-tool manifest. Tenon's pinned command table must
  be reviewed with every version bump.
- Full Access shell is not an OS sandbox. The direct route keeps the supported
  Agent path isolated and auditable but does not contain a hostile same-user
  process that independently discovers the packaged executable or Broker.
- Browser authorization depends on a supported Chrome remote-debugging UI and a
  user Allow action Tenon cannot complete.
- Platform support is limited to Browser Pilot's published native assets; Intel
  macOS is unsupported.

## Open Questions

- Should a later release add a Settings status/diagnostics surface after the
  first CLI-only integration proves real usage?

## Subtasks

- Add the Browser action-kind and execution-versus-durable-projection foundation
  before its Browser Pilot consumer in the same PR.
- Add deterministic Browser Pilot 0.5 executable, skill, release index,
  checksum, manifest, and license inputs to the build.
- Add the direct `bp` bash route, pinned command conformance, capability mapper,
  Thread client key, Turn output environment, timeout/cancellation alignment,
  transient result handling, and durable projections.
- Add the upstream skill bundle plus the minimal Tenon host-integration note.
- Add capability, secret persistence, audit, concurrency, recovery, wait,
  cancellation, scratch, skill, and packaging tests.
- Complete the real-browser smoke workflow and record non-interference evidence.
- Fold shipped behavior into the listed specs in the same PR.
