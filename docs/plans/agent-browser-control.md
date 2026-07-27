# Agent Browser Control

## Goal

Let an Agent use Browser Pilot to control the user's own eligible Chromium tabs
and complete browser tasks with the user's existing Profiles, signed-in sessions,
cookies, extensions, and website state.

Tenon is a Browser Pilot consumer, not a second browser-automation
implementation. It bundles a pinned Browser Pilot executable and the matching
Browser Pilot skill. The Agent follows the skill and invokes `bp` through
Tenon's existing `bash` tool. Browser Pilot owns browser discovery,
authorization, tab control, observations, actions, captures, Broker
coordination, and cleanup.

CLI execution still crosses a Tenon-owned host boundary. Tenon assigns every
Thread an isolated Browser Pilot client identity, gives every Turn an ephemeral
output directory, classifies Browser Pilot commands before execution, applies
explicit capability blocks, projects raw Browser input and output into a
redacted durable view before any Item or extension hook can observe it, and
records the resolved external action descriptors on the canonical tool Item.

URL Preview remains Tenon's internal quick-preview surface. It is not a Browser
Control target, does not share a profile or controller with Browser Pilot, and
does not participate in Agent browser tasks.

## Non-goals

- Do not attach Electron CDP to URL Preview guests or make Preview panes
  controllable by the Agent.
- Do not reimplement Browser Pilot refs, target ownership, Profile routing,
  Broker coordination, or browser recovery inside Tenon.
- Do not project Browser Pilot's canonical operations as 39 Tenon-native tools
  in the first integration. The model-facing execution surface remains `bash`.
- Do not embed the Browser Pilot stdio adapter, add MCP, install a browser
  extension, or import Browser Pilot private source modules.
- Do not execute raw, unclassified `bp` commands. Browser Pilot CLI calls must
  pass Tenon's host launcher, Thread identity injection, command classifier, and
  capability audit.
- Do not search `PATH`, run `npx`, install a global package, or download a runtime
  when the packaged app starts.
- Do not use URL Preview session data as a fallback when the user's browser is
  unavailable or not authorized.
- Do not claim that CLI mode provides semantic knowledge of a website's business
  operation. Ambiguous browser mutations are classified conservatively.
- Do not branch host code on English CLI errors. Typed host recovery remains out
  of scope until Browser Pilot publishes a stable machine-readable CLI error
  contract.

## Shape

This plan is one complete Browser Control feature, preceded by one required
interface-only checkpoint because the capability catalog is an A4 shared
surface:

1. A human-ratified interface-only PR adds the Browser action kinds, exact
   command-to-descriptor mapping, and the execution-versus-persistence
   projection contract to the Agent Core interfaces and permission specs. The
   contract makes extension lifecycle arguments/results and canonical Item
   fields durable projections rather than raw execution values. It ships no
   Browser Pilot runtime.
2. One feature PR packages Browser Pilot, adds the host launcher and classifier,
   injects Thread/Turn context, bundles the skill, and proves the complete user
   workflow.

The feature is complete only when a packaged Tenon Agent can discover the skill,
invoke the bundled CLI through the classified `bash` path, connect to the user's
browser, perform and verify a browser task, and leave unrelated user tabs
untouched.

## Collision Result

- No open PR claims this plan or the Browser Pilot packaging and skill areas.
- `docs/plans/browser-extension-integration.md` is restricted to future
  read-only URL Preview extraction and has no Browser Control dependency.
- The implementation touches shared action kinds plus infrastructure-owned build
  inputs. The interface checkpoint and implementation must use separate, ordered
  Draft PR claims.
- `docs/TASKS.md` and `CHANGELOG.md` remain main-agent-owned and are updated at
  the merge gate.

## Design

### Product Boundary

| Capability | URL Preview | Browser Control |
|---|---|---|
| Purpose | Quickly preview an HTTP(S) URL inside Tenon | Let an Agent complete tasks in the user's browser |
| Runtime | Sandboxed Electron webview | Browser Pilot CLI and per-user Broker |
| Browser state | Tenon-owned `persist:url-preview` partition | User-owned Chromium Profiles and signed-in sessions |
| Agent access | None | Classified `bp` invocation through Tenon `bash` |
| Targets | Visible Preview panes | Eligible user tabs and Browser Pilot-managed tabs |
| Lifecycle | Workspace preview lifecycle | Thread-keyed Browser Pilot CLI namespace |

Neither side discovers, adopts, or controls the other's targets. Opening the
same URL in both surfaces does not create shared identity, cookies, tabs, refs,
or permissions.

### Browser Pilot Baseline And Distribution

- Pin the first published Browser Pilot release that provides stable one-shot
  client namespaces through `BROWSER_PILOT_CLIENT_KEY` / `--client-key`. The
  current upstream candidate is `v0.4.0`; published `v0.3.0` is not an acceptable
  integration baseline because independent CLI Agents share its default state.
- Review the executable version, matching upstream skill revision, archive
  checksum, manifest, and licenses as one integration input.
- Stage the native executable and licenses into a generated build directory and
  copy it with Electron Builder `extraResources`.
- Packaged Tenon resolves the raw executable only under `process.resourcesPath`.
  Source runs use a repository-generated asset or one explicit absolute
  development override. There is no global or runtime-download fallback.
- Fail the build on a missing asset, checksum mismatch, manifest mismatch,
  unsupported platform/architecture, or executable version mismatch.
- Platform support follows verified Browser Pilot release assets. Tenon does not
  rebuild or emulate a missing upstream architecture.

### Host Launcher And Bash Path

The model-visible workflow stays CLI-based:

```text
Agent -> Tenon bash -> host-owned bp launcher -> bundled Browser Pilot -> user browser
```

Tenon adds only the host integration needed around the CLI:

- Prepend the directory containing Tenon's `bp` launcher to the Agent process
  environment. Do not add the raw Browser Pilot executable directory to `PATH`.
- The launcher invokes the verified raw executable by its absolute
  `process.resourcesPath` location.
- The `bash` preflight recognizes only a direct, supported `bp` command form.
  It rejects client-key flags or assignments, alternate executable paths, and
  compound shell syntax around `bp`; the model cannot choose its namespace or
  bypass the Browser command mapper through the supported path.
- The host injects the canonical client key and Turn output directory after
  parsing. Caller-supplied values never override them.
- Browser Pilot commands remain normal one-shot CLI processes. Tenon does not
  launch `bridge --stdio`, call `tools/list`, or persist Browser Pilot protocol
  identities.

The Browser Pilot skill is available only when both `bash` and the Browser Pilot
integration survive the effective Thread Configuration and parent ceiling.
Installing the skill does not widen a restricted child Thread's tool catalog.

### Thread Identity And Concurrent Agents

Each independent root, child, isolated-skill, or forked Thread receives a unique,
stable Browser Pilot client key. Repeated Turns in the same Thread reuse that
key so selected target, frame, refs, auth, and network state remain coherent.

The host derives the key from Tenon's stable installation identity and canonical
`thread.id`, for example:

```text
tenon.<base64url(sha256(installationId + ":" + thread.id))>
```

The key is bounded to Browser Pilot's published syntax, never includes
`turn.id`, and is never accepted from model input. Distinct Thread IDs therefore
receive distinct Browser Pilot Principals, Workspaces, and Leases even when they
run concurrently in one Tenon process. Browser Pilot remains responsible for
exclusive target ownership and handoff between those namespaces.

Turn completion retains the Thread namespace for later Turns. Thread deletion or
an explicit host-owned Browser reset runs `bp disconnect` through the launcher
with that Thread's key, releasing only its managed targets. Process crashes rely
on Broker Lease expiry for bounded cleanup.

### Turn-Scoped Output Directory

Browser state is Thread-scoped, while files produced for one execution are
Turn-scoped. Before tool creation, Tenon creates:

```text
<agentScratchRoot>/browser-pilot/<thread-id>/<turn-id>/
```

The host exposes this absolute app-owned path to the classified launcher as
`TENON_BROWSER_OUTPUT_DIR`. The skill uses it only inside `bash`, for example:

```bash
bp screenshot "$TENON_BROWSER_OUTPUT_DIR/page.png"
```

Every Browser Pilot output-writing form, including screenshot, PDF, and network
body save, requires an explicit destination that canonicalizes inside this
directory; omitted or escaping destinations are rejected. Browser Pilot returns
the resolved absolute file path. The Agent then uses `file_read`, which already
converts image content for the model and handles PDFs or files through existing
Thread resource paths. The directory follows the normal agent-scratch TTL and
file contents do not enter Thread history unless a later tool explicitly reads
them. Durable Browser Items retain only the redacted command family and safe
target context described below; raw Profile selectors, secret-bearing command
arguments, and Broker identities are not persisted as Tenon Items or resources.

### Execution And Persistence Redaction Boundary

The Browser preflight creates one immutable per-call execution envelope before
`item/started`, capability audit publication, extension lifecycle notification,
or debug logging:

```text
raw model input
  -> direct bp parse and classify
  -> memory-only execution values + durable redacted projection
  -> capability preflight
  -> raw process execution
  -> result redaction
  -> model result + Item/outputRef/hooks/history/Memory
```

The two views have different authority:

- **Execution values** contain the original parsed command and arguments needed
  to invoke the bundled executable. They stay in the active tool call's memory,
  are passed only to capability evaluation and process spawn, and are discarded
  on completion. They never become `JsonValue` lifecycle payloads, Items,
  notifications, logs, diagnostics, history, or extension state.
- **Durable projection** contains the canonical command family/subcommand,
  applicable action kinds, structural flags, bounded numeric refs/indices, and
  placeholders for sensitive values. This is the only view supplied to
  `commandExecution.command`, every `commandActions` field, rollout JSONL,
  history projection and replay, renderer IPC, forks, extension hooks, Memory
  evidence, diagnostics, and logs.

The parser treats all free-form values as sensitive unless an explicit allowlist
proves they are structural. It redacts type and keyboard text, dialog prompt
text, HTTP-auth usernames and passwords, header values, mock bodies, URLs and
Profile selectors, search text and selectors, eval source, network filters and
patterns, and arbitrary upload/source paths. App-owned output destinations are
canonicalized to
`$TENON_BROWSER_OUTPUT_DIR/<safe-name>`; arbitrary local source paths are never
retained. The per-call envelope also retains the decoded sensitive values and
their CLI/JSON encodings only as an in-memory taint set for result redaction.

Raw stdout, stderr, structured details, and thrown errors pass through the same
boundary before they are returned to the model or supplied to Item completion.
The result redactor removes credential-bearing structured fields and replaces
cookie values, authorization/header values, and every tainted input
representation that Browser Pilot could echo. The sanitized result is the sole
input to the model-visible tool result, bounded `aggregatedOutput`, extension
completion hooks, history reconstruction, and the complete content-addressed
tool-output store behind `outputRef`. No full-output or overflow path may retain
the raw result as a fallback.

If a command that resolves to `bp` cannot be parsed, classified, projected, or
its result cannot be safely sanitized, the host fails closed: it does not spawn
Browser Pilot, emits only a constant redacted failure projection, and discards
the raw value. Generic secret-like regexes remain defense in depth; they are not
the Browser persistence contract.

### Capability Classification And Audit

Raw `bp` currently falls through to `shell.unknown`, which is not acceptable:
it makes browser effects look local and allows Browser commands to bypass
Browser or external-action blocks. The interface checkpoint adds these canonical
action kinds:

| Action kind | Access | Browser Pilot command class |
|---|---|---|
| `browser.read` | read, external system | discovery, inventory, observe, read, search, find, capture |
| `browser.control` | control, external system | connect, Profile/target selection, navigation, scroll, dropdown, tab/frame state |
| `browser.external_action` | write, external system | click, type, keyboard, press, select, upload, dialog response, auth changes, tab close, eval/network mutation |
| `browser.sensitive_read` | read, external system | every command that can expose user-browser context, including identity/inventory, page state, post-action observations, captures, cookies, auth, eval, and network results |
| `browser.developer` | control, external system | eval and network interception/modification |

Every recognized command receives all applicable descriptors before execution.
Any matching explicit block makes the command unavailable and records the same
descriptor and rule on the canonical `bash` Item. Capability evaluation may
inspect memory-only execution values, but published descriptors and audit data
are built exclusively from the durable projection.

Browser Pilot cannot know whether an arbitrary click sends a message, submits a
form, purchases an item, or changes an account. Until the host has trustworthy
semantic evidence, every `browser.external_action` command also receives the
existing `external.message.send` descriptor. This deliberately over-blocks
harmless page interaction when `Action(external.message.send)` is configured,
but it prevents Browser Pilot from bypassing that existing user contract.
`Action(browser.external_action)` is the broad switch for all ambiguous outward
browser mutations.

The initial mapping attaches `browser.sensitive_read` to every supported command
that can reveal URLs, titles, Profile/account identity, tabs, frames, dialogs,
DOM/page content, element values, local paths, screenshots/PDFs, cookies, auth,
or network data. This includes:

- browser, Profile, tab, frame, dialog, and interception-rule inventories;
- `snapshot`, `read`, `search`, `find`, `locate`, `dropdown`, `screenshot`,
  `pdf`, `cookies`, `eval`, and network inspection;
- `connect` when it may return Profile context; and
- `profile`, `tab`, `open`, `close`, `click`, `type`, `keyboard`, `press`,
  `scroll`, `select`, `dialog`, `upload`, auth, eval, and network mutations when
  their result or error can return page state or echo sensitive input.

`disconnect` is the only initial metadata-only exception, backed by a pinned
CLI conformance test proving a fixed status-only result. A new or changed
Browser Pilot command defaults to `browser.sensitive_read` until equivalent
conformance proves that it cannot expose user-browser context.
`Action(browser.sensitive_read)` is evaluated before process spawn, so blocking
it also blocks post-action observation; the host never performs the mutation and
then suppresses only its result.

Commands outside the explicit Browser Pilot mapping do not silently fall back
to a less restrictive Browser classification. Adding or reclassifying a Browser
Pilot command changes the shared action contract and requires the same A4 review.
Audit output uses the same durable projection rather than a separately redacted
copy. It retains the command family, safe target context when available, and
resolved action kinds, but never raw typed text, auth or cookie values, header
values, upload paths, or other free-form arguments.

### Skill Contract

Bundle a resource-backed built-in `browser-pilot` skill from the same pinned
Browser Pilot tag as the executable. Keep Browser Pilot's command and recovery
guidance upstream-owned; Tenon-specific text removes installation fallback and
documents the host launcher, capability boundary, and Turn output variable.

The skill teaches the Agent to:

- use Browser Pilot only for work requiring a real browser, signed-in state, or
  interaction; keep simple public retrieval on `web_*`;
- call passive discovery first and call `bp connect` only when authorization is
  required;
- list tabs and Profiles before adopting context, ask when the intended Profile
  or user tab is ambiguous, and prefer a managed tab for independent work;
- observe/read/search before acting, replace stale refs after page or frame
  changes, and verify the resulting page state;
- use dedicated commands before eval and keep sensitive output bounded;
- leave user-owned tabs open unless the task explicitly requires closing one;
- place captures under `$TENON_BROWSER_OUTPUT_DIR` and use `file_read` on the
  returned absolute path;
- never supply `--client-key`, override host environment variables, or invoke a
  raw Browser Pilot executable path.

The skill is model-discoverable and does not duplicate Browser Pilot guidance in
the stable system prompt.

### User Interaction And Authorization

- Tenon includes Browser Pilot; the user does not separately install a CLI or
  extension.
- Browser discovery is passive. The first task that needs a browser may run
  `bp connect`; Chrome owns remote-debugging enablement and the Allow prompt.
- The Agent reports setup remediation and waits when Chrome requires user
  interaction. It does not loop connection attempts or claim success early.
- One authorized endpoint can expose several Profiles and all eligible tabs.
  Profile selection routes newly managed tabs; it is not an access-control
  boundary for existing tabs.
- The first integration adds no separate Tenon browser window or duplicate
  approval flow. A dedicated Settings status surface is a later product decision.

### Failure And Recovery

The CLI and skill own normal interactive recovery. Tenon's host launcher relies
only on process exit, bounded output, and verified output files; it does not parse
English error messages into stable codes.

- A disconnected browser pauses browser work until explicit reconnect is
  appropriate; then the Agent lists tabs/Profiles and observes again.
- Busy-target output causes the Agent to choose another tab or wait. The host
  does not depend on a stable `target_busy` code until Browser Pilot publishes
  one for one-shot CLI consumers.
- Stale refs, frames, Profiles, and targets are rebuilt from fresh CLI state.
- Routine completion does not disconnect the Broker. Temporary managed tabs may
  be closed; user-owned tabs remain open.
- A timed-out or uncertain mutating command is inspected before any retry.

Stable machine-readable CLI error codes remain an upstream Browser Pilot
improvement and are not required by this CLI-first plan. The pinned release must
contain the documented client-key mechanism and discoverable CLI help before
Tenon can ship the integration.

### Specs And Documentation

The interface checkpoint updates:

- `src/core/agent/tools.ts`: ratified Browser action kinds;
- `src/core/agent/extensions.ts`: lifecycle arguments and results are explicitly
  durable projections, with raw execution values unavailable to extensions;
- `src/core/agent/protocol.ts`: `commandExecution` and `commandActions` fields
  are persistence-only projections and cannot contain raw Browser arguments;
- `docs/spec/agent-tool-permissions.md`: Browser descriptor/block semantics and
  conservative external-action and sensitive-read mapping;
- `docs/spec/agent-tool-design.md`: the pre-persistence projection contract,
  `bp` classifier, and canonical Item audit.

The feature PR updates current behavior in:

- `docs/spec/agent-integration.md`: Thread/Turn/Item integration checklist;
- `docs/spec/agent-skills.md`: bundled Browser Pilot skill provenance and
  packaging;
- `docs/spec/agent-tool-design.md`: Thread identity, Turn output environment,
  launcher execution, durable projection, result redaction, and file-result
  flow;
- packaging documentation: pinned assets, checksums, manifests, licenses, and
  development override.

URL Preview specs remain exclusively about internal preview behavior.

## Validation

- Verify archive checksum, manifest, licenses, executable bit, architecture, and
  `bp --version` during the build.
- Prove Agent `PATH` resolves Tenon's launcher and cannot select a global `bp`;
  prove the launcher invokes only the pinned absolute executable.
- Prove caller-supplied client keys, alternate executable paths, and compound
  Browser Pilot shell forms are rejected.
- Run repeated commands in one Thread and prove they reuse selected target/frame/
  refs across Turns.
- Run two root/child Threads concurrently and prove distinct keys isolate target,
  frame, ref, auth, and network state; acquiring the same user tab must not allow
  one Thread to act through the other's state.
- Prove `Action(browser.read)`, `Action(browser.control)`,
  `Action(browser.external_action)`, `Action(browser.sensitive_read)`, and
  `Action(browser.developer)` block their mapped commands.
- Run the exhaustive command matrix against an authenticated fixture and prove
  `Action(browser.sensitive_read)` blocks Profile/tab inventory, every page
  observation and capture, and every action that returns post-action state
  before Browser Pilot is spawned. Prove only the conformance-tested
  metadata-only exception remains callable.
- Prove `Action(external.message.send)` conservatively blocks click, type,
  keyboard, press, select, upload, dialog response, and eval command classes.
- Use unique canary secrets in type/keyboard text, auth, dialog prompts, upload
  paths, headers, mock bodies/files, URLs, Profile selectors, search terms, and
  eval source. Make the fake CLI echo raw and encoded variants in stdout,
  stderr, structured details, and errors; prove none appear in the model-visible
  result, started/completed Items, `commandActions`, rollout JSONL,
  history projection/replay, renderer notifications, forks, extension hooks,
  Memory evidence, diagnostics, logs, or content-addressed complete outputs.
- Prove parse, projection, and result-sanitization failures do not spawn Browser
  Pilot and produce only a constant redacted failed Item/result.
- Verify allowed calls record `external_system`, the shared durable command
  projection, and all action descriptors on the canonical `bash` Item.
- Verify each Turn receives a distinct app-owned output directory, capture files
  are readable through `file_read`, and scratch pruning removes expired output.
- Verify skill discovery and that its instructions never recommend npm, `npx`,
  global fallback, caller-selected client keys, or raw executable paths.
- Run a real-browser smoke task: inventory Profiles/tabs, open a managed tab,
  observe/read, perform a disposable verified form action, capture an image,
  and clean up only the managed tab.
- Confirm pre-existing user tabs remain open and unchanged, URL Preview receives
  no Browser Control attachment, and a Thread without `bash`/Browser capability
  cannot invoke the integration.
- Run Browser Pilot distribution/conformance gates for the exact packaged asset,
  then run repository typecheck, relevant Core tests, packaging verification,
  docs check, and diff check.

## Risks

- Conservative mapping of ambiguous page interaction to
  `external.message.send` intentionally blocks more than actual messaging.
- `browser.sensitive_read` is intentionally coarse. When it is allowed, private
  authenticated page content may enter model context and Thread history; Tenon
  does not claim to infer sensitivity from a site or URL. Binary captures are
  governed by this preflight and scratch/file-read lifecycle rather than text
  redaction.
- Tenon's Full Access shell is not an OS sandbox. The classified launcher keeps
  the supported Agent path auditable but does not claim to constrain a hostile
  same-user process that independently discovers browser internals.
- Browser authorization depends on Chromium remote-debugging support and a user
  Allow action Tenon cannot complete.
- Browser Pilot and its skill can drift if bumped independently.
- Platform support is limited by published Browser Pilot native assets.

## Open Questions

- Should a later release add a Settings status/diagnostics surface after the
  first CLI integration proves real usage?
- Which additional platform/architecture assets must Browser Pilot publish
  before Tenon expands beyond its initial packaging target?

## Subtasks

- Land the human-ratified interface-only Browser action-kind checkpoint.
- Add deterministic Browser Pilot executable, skill, checksum, manifest, and
  license inputs to the build.
- Add the host-owned launcher, direct-command parser, capability mapper,
  execution/persistence projection and result redaction, stable Thread client
  key, and Turn output environment.
- Add the pinned resource-backed `browser-pilot` skill with Tenon-specific
  integration guidance.
- Add capability, sensitive-data persistence, audit, concurrency, scratch,
  skill, and packaging tests.
- Complete the real-browser smoke task and record non-interference evidence.
- Fold shipped behavior into the listed specs in the implementation PR.
