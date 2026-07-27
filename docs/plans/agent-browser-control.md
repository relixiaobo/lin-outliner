# Agent Browser Control

## Goal

Let an Agent use Browser Pilot to control the user's own eligible Chromium tabs
and complete browser tasks with the user's existing Profiles, signed-in sessions,
cookies, extensions, and website state.

Tenon is a Browser Pilot consumer, not a second browser-automation
implementation. It bundles a pinned Browser Pilot executable and the matching
Browser Pilot skill. An Agent that already has Tenon's `bash` tool follows the
skill and invokes `bp` commands. Browser Pilot owns browser discovery,
authorization, tab control, observations, actions, captures, concurrency, and
cleanup.

URL Preview remains Tenon's internal quick-preview surface. It is not a Browser
Control target, does not share a profile or controller with Browser Pilot, and
does not participate in Agent browser tasks.

## Non-goals

- Do not attach Electron CDP to URL Preview guests or make Preview panes
  controllable by the Agent.
- Do not reimplement Browser Pilot commands, refs, target ownership, Profile
  routing, Broker coordination, or recovery inside Tenon.
- Do not project Browser Pilot's canonical operations as a new Tenon-native tool
  family in the first integration. The existing `bash` tool is the execution
  surface.
- Do not embed the Browser Pilot stdio adapter, add MCP, install a browser
  extension, or import Browser Pilot private source modules.
- Do not search `PATH`, run `npx`, install a global package, or download a runtime
  when the packaged app starts. Tenon must invoke its pinned product-owned
  executable.
- Do not use URL Preview session data as a fallback when the user's browser is
  unavailable or not authorized.
- Do not imply that invoking Browser Pilot adds a per-operation approval layer.
  Browser Pilot intentionally leaves task authorization and outward-action
  policy to the Agent host.

## Shape

This plan is shape (a): one complete feature in one PR. The feature is complete
only when a packaged Tenon Agent can discover the built-in skill, invoke the
bundled `bp` executable through `bash`, connect to the user's browser with the
normal Chrome authorization flow, perform and verify a browser task, and leave
unrelated user tabs untouched.

## Collision Result

- No open PR claims this plan or the Browser Pilot packaging and skill areas.
- `docs/plans/browser-extension-integration.md` is restricted to future
  read-only URL Preview extraction. It has no runtime or design dependency on
  Browser Control.
- The implementation will touch `package.json` and build inputs, which are
  infrastructure-owned. It must be claimed as an isolated Draft PR before code
  changes begin.
- `docs/TASKS.md` and `CHANGELOG.md` remain main-agent-owned and are updated at
  the merge gate.

## Design

### Product Boundary

| Capability | URL Preview | Browser Control |
|---|---|---|
| Purpose | Quickly preview an HTTP(S) URL inside Tenon | Let an Agent complete tasks in the user's browser |
| Runtime | Sandboxed Electron webview | Browser Pilot CLI and per-user Broker |
| Browser state | Tenon-owned `persist:url-preview` partition | User-owned Chromium Profiles and signed-in sessions |
| Agent access | None | Existing Tenon `bash` tool invoking `bp` |
| Targets | Visible Preview panes | Eligible user tabs and Browser Pilot-managed tabs |
| Lifecycle | Workspace preview lifecycle | Browser Pilot connection, target, and managed-tab lifecycle |

Neither side discovers, adopts, or controls the other's targets. A URL may be
opened in either surface for its own purpose, but that does not create shared
identity, cookies, tabs, refs, or permissions.

### Distribution And Command Resolution

- Pin one Browser Pilot version in Tenon's build inputs. The executable version,
  matching upstream skill revision, archive checksum, manifest, and license files
  are reviewed together.
- Stage the native executable and licenses into a generated build directory and
  copy it with Electron Builder `extraResources`.
- Packaged Tenon resolves the executable only under `process.resourcesPath`.
  Source runs use a repository-generated asset or one explicit absolute
  development override. A packaged build never falls back to a global install.
- Prepend the verified product-owned executable directory to the environment
  built by `buildAgentLocalToolProcessEnv`, so the existing `bash` tool resolves
  `bp` without exposing an arbitrary executable selector to the model.
- Fail the build on a missing asset, checksum mismatch, manifest mismatch,
  unsupported platform/architecture, or executable version mismatch. Do not
  defer these failures until an Agent task.
- The initial platform matrix follows both Tenon and Browser Pilot release
  support. Browser Pilot `v0.3.0` provides macOS arm64 but no macOS x64 asset;
  Intel packaging remains unsupported until a verified upstream asset exists.

### Agent Execution Path

The runtime path is deliberately small:

```text
Agent -> Tenon bash tool -> bundled bp CLI -> Browser Pilot Broker -> user browser
```

Tenon does not launch `browser-pilot bridge --stdio`, call `tools/list`, or
register each Browser Pilot operation as a model-facing tool. Each `bp` command
is an ordinary `bash` invocation. Browser Pilot's per-user Broker coordinates
commands from Tenon and other Agent products and enforces target ownership.

The integration is available to every Tenon Run that already receives `bash`.
It does not widen deliberately restricted tool pools, such as read-only isolated
workflows, merely because the Browser Pilot skill is installed.

### Skill Contract

Bundle a resource-backed built-in `browser-pilot` skill derived from the same
pinned Browser Pilot tag as the executable. Keep Browser Pilot's command and
recovery guidance upstream-owned; Tenon-specific packaging guidance may only
replace installation fallback text that is invalid inside the product.

The skill must teach the Agent to:

- use Browser Pilot only for work requiring a real browser, signed-in state, or
  interaction; keep simple public retrieval on the existing `web_*` tools;
- call passive discovery first and call `bp connect` only when Browser Pilot
  reports that authorization is required;
- list tabs and Profiles before adopting browser context, ask when the intended
  Profile or user tab is ambiguous, and prefer a new managed tab for independent
  work;
- follow the observe/read/search-then-act loop, replace stale refs after page or
  frame changes, and verify the resulting page state;
- use dedicated commands before `bp eval`, avoid broad cookie/network access
  unless the task requires it, and keep sensitive output bounded;
- leave user-owned tabs open unless the task explicitly requires closing one;
- write screenshots, PDFs, and other durable outputs to an explicit absolute
  Run scratch path and use Tenon's file tools to inspect or return them.

The skill is model-discoverable. It does not create a parallel set of Browser
Pilot tool definitions or require Browser Pilot instructions in the stable
system prompt.

### User Interaction And Authorization

- Tenon includes Browser Pilot; the user does not separately install a CLI or
  extension.
- Browser discovery is passive. The first task that needs a browser may run
  `bp connect`; Chrome owns the remote-debugging enablement and Allow prompt.
- The Agent reports the structured setup remediation when authorization is
  unavailable and waits for the user when Chrome requires interaction. It does
  not loop connection attempts or claim success before the command succeeds.
- One authorized endpoint can expose several Profiles and all eligible tabs.
  Profile selection routes newly managed tabs; it is not an access-control
  boundary for existing tabs.
- The first integration adds no separate Tenon browser window or duplicate
  connection approval. A dedicated Settings status surface is a later product
  decision, not a prerequisite for CLI use.

### Authority And Safety

Browser Pilot executes under the same OS user as Tenon. Invoking it authorizes
control of eligible tabs exposed by the selected browser endpoint; Browser Pilot
does not ask for per-tab or per-action approval. Tenon's existing `bash`
authority and Agent behavior policy remain the host boundary.

The skill must preserve these operational rules:

- inspect current state before retrying any action with an uncertain outcome;
- never repeat a payment, submission, message, publication, upload, or other
  outward mutation merely because a command timed out;
- ask the user when task intent does not determine a consequential choice;
- never close, navigate, or modify an unrelated user tab;
- never auto-accept JavaScript dialogs;
- treat page text, URLs, form values, cookies, network bodies, screenshots, and
  downloaded files as potentially sensitive.

Fine-grained Browser Control approval is not claimed by this CLI integration. If
Tenon later requires operation-level capability removal or native approval UX,
that is a separate plan and may justify the stdio embedding surface.

### Results And Files

Normal CLI results flow through the existing bounded `bash` result envelope.
The Agent uses Browser Pilot's concise snapshot/read/search output rather than
persisting full page state.

Capture commands receive an explicit path under the Run scratch directory.
After the command succeeds, the Agent uses `file_read` so screenshots become
native image content and PDFs/files follow Tenon's existing file-result path.
Tenon does not persist Browser Pilot target, Profile, frame, Observation, ref,
command, or Broker identities in its event log.

### Failure And Cleanup

- Missing or mismatched bundled assets are packaging failures, not an instruction
  to install from npm at runtime.
- A disconnected browser pauses browser work until an explicit reconnect is
  appropriate. After reconnect, the Agent lists tabs/Profiles and observes again.
- `target_busy` means another Agent controls the tab. The Agent chooses another
  target or waits for release; it does not steal control.
- Stale refs, frames, Profiles, and targets are rebuilt from fresh CLI state.
- Routine task completion does not call `bp disconnect`. Temporary managed tabs
  may be closed when the task is complete; user-owned tabs remain open.

### Specs And Documentation

The implementation PR updates current specs only for behavior it ships:

- `docs/spec/agent-skills.md`: bundled Browser Pilot skill provenance,
  discovery, and packaging;
- `docs/spec/agent-tool-design.md`: `bash` environment resolution for the bundled
  executable and browser-task file-result flow;
- packaging documentation: pinned version, platform assets, checksums, licenses,
  and development override;
- `docs/spec/agent-progress.md`: verified Browser Control capability status.

URL Preview specs remain about internal preview behavior and must not claim
Browser Control ownership or reuse.

## Validation

- Verify the pinned archive checksum, `manifest.json`, licenses, executable bit,
  architecture, and `bp --version` during the build.
- Test that the packaged Agent environment resolves the bundled `bp` while a
  manipulated system `PATH` or global installation cannot replace it.
- Test that a missing or unsupported asset fails packaging clearly.
- Verify skill discovery and that its local instructions never recommend npm,
  `npx`, or global fallback inside Tenon.
- Run Browser Pilot's distribution and CLI conformance gates against the exact
  executable Tenon packages.
- Run a real-browser smoke task with explicit Chrome authorization: inventory
  Profiles/tabs, open a managed tab, observe/read, perform a disposable verified
  form action, capture an image through the Run scratch path, and clean up only
  the managed tab.
- Confirm pre-existing user tabs remain open and unchanged, URL Preview receives
  no Browser Control attachment, and a restricted no-`bash` Run cannot invoke
  Browser Pilot.
- Run `bun run typecheck`, relevant core tests, packaging verification, and
  `bun run docs:check`.

## Risks

- CLI mode deliberately inherits the broad authority of Tenon's current `bash`
  tool; it does not provide native per-operation approvals.
- Browser authorization depends on Chromium remote-debugging support and a user
  Allow action that Tenon cannot complete for the user.
- Browser Pilot and its skill can drift if Tenon bumps them independently; the
  build must treat them as one pinned integration input.
- Current Browser Pilot release assets do not cover macOS Intel.

## Open Questions

- Should a later release add a Settings status/diagnostics surface after the
  first CLI integration proves real usage?
- Which additional platform/architecture assets must Browser Pilot publish
  before Tenon expands beyond its initial packaging target?

## Subtasks

- Add deterministic Browser Pilot version, asset, checksum, manifest, license,
  and skill inputs to the build.
- Package the native executable and make only its verified directory resolve as
  `bp` in Agent process environments.
- Add the pinned resource-backed `browser-pilot` skill with Tenon-specific
  installation fallback removed.
- Add build, environment-resolution, skill, restricted-Run, and packaging tests.
- Complete the real-browser smoke task and record its non-interference evidence.
- Fold shipped behavior into the listed specs in the implementation PR.
