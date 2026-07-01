# Agent Computer Control Tool

## Goal

Build a Tenon-native computer-use capability for the agent. The capability must
cover the full useful surface of `~/Coding/computer-pilot` and its `cu` CLI while
respecting Tenon's TypeScript/Electron architecture, permission model, event
log, and multimodal tool-result pipeline.

The user-facing capability is the Computer Control tool family. It lets the
agent inspect macOS applications and windows, capture screenshots and annotated
AX snapshots, find UI elements, OCR regions, click, type, press keys, set AX
values, perform AX actions, scroll, hover, drag, wait for UI state, run
scriptable-app automation, read/write defaults, and manage windows and app
launch state.

The critical product requirement is that visual results are first-class tool
results. Screenshots, annotated screenshots, OCR regions, and action verification
captures are returned to the model as image content when useful, not as CLI file
paths that the model cannot see.

## Non-goals

- Do not add Rust, Cargo, Tauri, or `src-tauri` product runtime code to this
  repo.
- Do not expose arbitrary shell execution to the model as the computer-use
  implementation.
- Do not bypass macOS TCC, Screen Recording, Accessibility, Automation, or
  capture-protection limits.
- Do not hide disruptive actions. Any focus change, global input fallback,
  window move, AppleScript mutation, or defaults write must be visible in the
  tool result and permission decision.
- Do not attempt cross-platform desktop control in this plan. The initial scope
  is macOS because `computer-pilot/cu` is macOS-specific.
- Do not persist screenshots or AX trees outside the event-log and payload
  retention model.

## Shape

This plan is shape (b): a set of independently shippable complete features. Each
implementation unit delivers a complete, useful subset of Computer Control, while
the full plan covers all `computer-pilot` capabilities.

## Collision Result

- PR #359, "Use linlab skills for bundled artifacts", has landed. Computer
  Control's built-in skill should use the resource-backed built-in skill
  mechanism in `docs/spec/agent-skills.md`: development loads from
  `src/main/builtInSkills` or enabled linlab roots, `bun run skills:sync` stages
  tracked files into `build/generated/built-in-skills`, and the packaged app
  loads them from `Resources/built-in-skills`.
- No active code PR was found claiming macOS desktop-control agent tools.
- `docs/plans/launcher-provider-expansion.md` is adjacent because it discusses
  app-provider expansion, but this plan owns interactive computer control rather
  than launcher capture.
- Implementation will touch shared agent tool registration, permission classes,
  event-log payload behavior, and specs. The first PR should keep these shared
  seams small and explicit.
- This plan intentionally does not edit `docs/TASKS.md`; that file is
  main-agent-owned.

## Reference Coverage

`computer-pilot/cu` command coverage maps into a Tenon-owned tool family:

| `cu` surface | Tenon surface |
|---|---|
| `setup` | `computer_setup` |
| `apps`, `menu`, `sdef`, `examples` | `computer_discover`, built-in skill recipes |
| `state`, `snapshot`, `find`, `nearest`, `observe-region`, `ocr`, `screenshot` | `computer_observe` |
| `wait` | `computer_wait` |
| `click` | `computer_click` |
| `type` | `computer_type` |
| `key` | `computer_key` |
| `set-value`, `perform`, `why` | `computer_ax` |
| `scroll`, `hover`, `drag` | `computer_pointer` |
| `tell` | `computer_script` |
| `defaults read`, `defaults write` | `computer_defaults` |
| `window list`, `window move`, `window resize`, `window focus`, `window minimize`, `window unminimize`, `window close` | `computer_window` |
| `launch`, `warm` | `computer_app` |

## Design

### Product Boundary

Computer Control is implemented as a first-party agent capability:

- The model calls Tenon tools, not `cu` directly.
- Electron main owns all native process execution and payload ingestion.
- Renderer code never sees raw filesystem screenshot paths or AX dumps except
  through normalized event-log payloads.
- Tool descriptions stay short; the built-in `computer-control` skill carries
  the decision tree, app-specific recipes, and anti-patterns.
- The backend is replaceable. The first backend adapts `cu` because it is already
  a high-quality reference implementation; a future native Swift or JS bridge can
  implement the same `ComputerController` interface.

This respects A1 by not adding Rust runtime code to the product repo. If Tenon
eventually bundles a prebuilt helper binary, that packaging decision is separate
from adding Rust source or a Rust build pipeline here.

### Main-Process Architecture

Add a main-process `ComputerControlService` with these layers:

- `ComputerController`: backend-neutral interface for desktop observation and
  actions.
- `CuComputerController`: initial backend that invokes `cu` through
  `execFile`, never through a shell.
- `ComputerRefStore`: run-scoped mapping from `snapshotId` and `ref` to AX path,
  app, process id, window id, and geometry.
- `ComputerPayloadWriter`: reads backend screenshot outputs, writes image
  payloads, and removes owned temp files.
- `ComputerPermissionAdapter`: maps desktop operations to the existing agent
  permission stack.
- `ComputerSetupDoctor`: resolves helper location, version, macOS permissions,
  and capability availability.

All helper invocations use an allow-listed argv builder. No tool input is
concatenated into shell text.

### Helper Resolution

The initial backend resolves `cu` in this order:

1. `TENON_CU_PATH`, for development and advanced users.
2. A future signed/bundled helper location, if product packaging approves it.
3. A PATH lookup for local development.

`computer_setup` reports:

- helper found or missing;
- helper version and supported JSON schema version;
- Accessibility permission;
- Screen Recording permission;
- Automation permission if scriptable app control is requested;
- capture-protected-window limitations;
- exact remediation text.

Missing setup must be a useful diagnostic result, not a generic tool failure.

### Tool Surface

The tool family is compact but preserves the important `cu` distinctions.

| Tool | Purpose |
|---|---|
| `computer_setup` | diagnose helper availability and macOS permission state |
| `computer_discover` | list apps, app menus, scripting dictionaries, and available examples |
| `computer_observe` | state, AX snapshot, diff snapshot, find, nearest, OCR, region observation, screenshots |
| `computer_wait` | wait for app, window, element, text, OCR, or state transition |
| `computer_click` | click by ref, AX path, text, or coordinates |
| `computer_type` | type text into an app or element, with paste routing when needed |
| `computer_key` | send keys and shortcuts |
| `computer_ax` | set AX values, perform AX actions, explain why an action is unavailable |
| `computer_pointer` | scroll, hover, and drag |
| `computer_script` | run AppleScript `tell` commands for scriptable apps |
| `computer_defaults` | read and write macOS defaults |
| `computer_window` | list, focus, move, resize, minimize, unminimize, and close windows |
| `computer_app` | launch apps and warm app state |

Each tool returns a standard envelope plus a concise model-visible projection.
Large AX trees, screenshots, OCR images, and action verification captures are
stored as payloads.

### Result Protocol And Media

Every computer result has a stable outer shape:

```ts
type ComputerToolResult = {
  ok: boolean;
  app?: string;
  pid?: number;
  windowId?: number;
  observationId?: string;
  snapshotId?: string;
  method?: string;
  verified?: boolean;
  media?: ComputerMediaRef[];
  payloads?: ComputerPayloadRef[];
  warnings?: ComputerWarning[];
  nextActionHint?: string;
};
```

Important `cu` reliability fields must be preserved:

- `method`, such as `ax-action`, `ax-set-value`, `ax-perform`,
  `cgevent-pid`, `double-click-pid`, `cgevent-right-pid`, `unicode-pid`,
  `paste-pid`, `key-pid`, `ocr-text-pid`, or the corresponding flagged global
  fallbacks such as `cgevent-global`, `double-click-global`,
  `cgevent-right-global`, `paste-global`, and `key-global`;
- `verified`, `verify_diff`, and `verify_advice`;
- `settle_ms`;
- `paste_reason`;
- `truncation_hint`;
- `confidence_hint`;
- `screenshot_error`;
- display and image scale metadata.

Screenshots and annotated screenshots become image content when useful to the
next model step. Full raw JSON and large AX trees remain payload-backed.

### Ref And AX Path Model

Refs are ephemeral and snapshot-scoped:

- `computer_observe` returns a `snapshotId`.
- Element refs are valid only with that snapshot unless the tool also receives a
  stable AX path.
- AX paths can be passed across multiple steps when the UI structure is stable.
- If the target app, pid, window, or AX path no longer resolves, the tool returns
  `stale_ref` and asks the agent to observe again.

This mirrors `cu`: refs are convenient, AX paths are the durable selector, and
fresh observation is required after major UI changes.

### Observation

`computer_observe` supports all observation tiers from `cu`:

- `state`: frontmost app, windows, displays, optional screenshot, and high-level
  app state;
- `snapshot`: AX tree with refs, roles, titles, values, geometry, and AX paths;
- `snapshot` with diff against a previous snapshot;
- annotated snapshot image;
- `find`: locate elements by title, role, value, text, or AX path;
- `nearest`: find the nearest element to coordinates;
- `observe-region`: crop a screen region and return OCR/visual summary;
- `ocr`: OCR full screen, app window, or region;
- `screenshot`: capture display, app, window, or region.

The model-visible summary is always size limited. Full screenshots and annotated
images are returned as image content plus payload refs.

### Actions

Actions prefer non-disruptive, app-targeted paths:

- Always pass `--app` or equivalent app identity for actions when available.
- Prefer AX actions, AX set-value, and PID-targeted CGEvents.
- Use paste-based typing for CJK text and chat-like apps when the backend reports
  it is safer.
- Record the backend method in every result.
- Attach a post-action verification diff or snapshot by default for mutating
  actions.
- Return backend advice when verification fails or confidence is low.

Global fallbacks are not normal behavior. A tool call must explicitly request an
`allowGlobal` mode, the permission stack must classify it as high risk, and the
result must mark the method as global.

### Windows, Apps, And Scriptable Apps

`computer_window` covers the full `cu window` surface:

- list windows;
- focus window;
- move window;
- resize window;
- minimize and unminimize;
- close window.

`computer_app` covers app launch and warmup. `computer_discover` exposes the app
list, scriptability flag, menu tree, and scripting dictionary. `computer_script`
uses AppleScript for apps that are scriptable and where scripting is cleaner than
AX or pointer automation. `computer_defaults` reads and writes macOS defaults
with separate read/write permissions.

### Wait And Synchronization

`computer_wait` wraps the `cu wait` behavior so multi-step workflows can avoid
blind sleeps. It should support:

- app launched or frontmost;
- window exists or focused;
- AX element appears/disappears;
- text appears/disappears;
- OCR text appears in a region;
- UI state changes after an action.

Wait results include elapsed time, matched condition, and a small observation
summary. If a screenshot was needed to evaluate the wait, it is available as a
payload and optionally image content.

### Permission Model

Desktop control permissions are operation-specific:

- desktop observation;
- screen capture and OCR;
- app-targeted click/type/key/scroll;
- global input fallback;
- drag and hover;
- window focus/move/resize/close;
- AppleScript read;
- AppleScript mutation;
- defaults read;
- defaults write;
- launching apps.

The permission classifier should consider app, bundle id, action kind, target
label, target role, typed text sensitivity, whether a global fallback is
requested, and whether the operation can send data outside the local machine.

Hard safety decisions need PM approval before implementation for password entry,
payments, account-security settings, file deletion, permission changes, and
other irreversible actions in third-party apps.

### Built-In Skill

Add a built-in `computer-control` skill. This is the clean way to avoid bloated
tool descriptions.

The tool definitions should contain:

- concise purpose;
- input schema;
- permission-relevant behavior;
- result shape.

The skill should contain:

- when to use computer control instead of file, browser, or web tools;
- the tiered strategy: scriptable app first, AX tree second, OCR/screenshot last;
- how to use `computer_setup`;
- how refs, AX paths, screenshots, and verification work;
- recipes for text entry, CJK/chat apps, menu use, window management, OCR regions,
  and scriptable apps;
- anti-patterns, including coordinate-first clicking, global fallback without
  need, blind sleeps, acting without `--app`, and ignoring verification advice.

Detailed workflows belong in the skill, not in every tool description.

### Specs And Documentation

Update the current specs in the same implementation PRs:

- `docs/spec/agent-tool-design.md`: tool registry, result examples, permission
  classes, and Computer Control family.
- `docs/spec/agent-event-log-rendering.md`: screenshot, annotated screenshot,
  OCR image, and large AX payload treatment.
- `docs/spec/agent-pi-mono-implementation.md`: main-process computer controller
  and helper invocation rules.
- `docs/spec/agent-progress.md`: progress checklist for Computer Control.
- `docs/spec/agent-skills.md`: Computer Control skill as a resource-backed
  built-in staged by `bun run skills:sync` and packaged under
  `Resources/built-in-skills`.

## Implementation Units

### Unit 1: Setup, Discovery, And Visual Observation

Complete feature: the agent can diagnose setup, discover apps, observe desktop
state, inspect AX trees, OCR regions, and return screenshots as image tool
results.

Scope:

- `ComputerController` and `CuComputerController` foundation;
- helper resolution and version checks;
- `computer_setup`, `computer_discover`, `computer_observe`;
- app list, menu tree, scripting dictionary, and examples exposure;
- screenshot, annotated snapshot, OCR, find, nearest, observe-region, and state;
- payload ingestion from backend output paths;
- first version of `computer-control` skill focused on observation;
- tests with mocked `cu` JSON and image outputs.

### Unit 2: App-Targeted Actions And Verification

Complete feature: the agent can safely interact with an app through AX and
PID-targeted input, with verification.

Scope:

- `computer_click`, `computer_type`, `computer_key`, `computer_ax`,
  `computer_pointer` scroll, and `computer_wait`;
- app-targeted action requirement and high-risk global fallback gate;
- preserve `method`, `verified`, `verify_diff`, `verify_advice`, `settle_ms`,
  and `paste_reason`;
- post-action snapshots and annotated screenshots;
- tests for no shell invocation, argv escaping, permission classification,
  stale refs, action verification, CJK paste routing, and no global fallback
  unless explicitly approved.

### Unit 3: Window, App, And Scriptable-App Control

Complete feature: the agent can manage app/window state and use scriptable app
automation where it is more reliable than pointer automation.

Scope:

- `computer_window` list/focus/move/resize/minimize/unminimize/close;
- `computer_app` launch and warm;
- `computer_script` AppleScript `tell`;
- `computer_defaults` read and write;
- Automation and defaults permissions;
- tests for read-vs-mutate permissions, app targeting, window identity, and
  capture-protected-window reporting.

### Unit 4: Advanced Pointer Control And Robustness

Complete feature: the agent can handle the remaining hard desktop cases while
keeping disruption explicit and audited.

Scope:

- hover and drag;
- coordinate actions with display/app context;
- explicit `allowGlobal` mode;
- richer `why` diagnostics through `computer_ax`;
- confidence/advice propagation for low-confidence OCR and truncated snapshots;
- optional macOS smoke tests gated on local `cu` availability and TCC state.

## Validation

Validation should combine mocked backend tests, optional macOS integration tests,
and payload/event-log tests:

- mocked `cu` JSON fixtures for every command family;
- argv builder tests proving inputs are never executed through a shell;
- payload tests proving screenshots and annotated images become image content and
  payload refs;
- permission tests for observation, screen capture, local app actions, global
  fallback, AppleScript, defaults write, and window close;
- stale-ref and AX-path tests;
- verification-result tests preserving `method`, `verified`, `verify_diff`, and
  `verify_advice`;
- optional smoke tests for `computer_setup`, `computer_observe`,
  `computer_click`, and `computer_type` when `cu` is installed on macOS;
- event-log tests proving no binary image data or huge AX tree is written into
  JSONL/React state.

## Open Questions

- Should the first implementation require a separately installed `cu`, or should
  Tenon ship a signed helper binary from day one?
- What helper version and JSON schema version are required?
- Which desktop actions are prohibited even with approval?
- Should screenshots be model-visible by default for all observations, or only
  when the tool asks for `includeScreenshot`?
- Which apps need app-specific recipes in the first `computer-control` skill?
- What is the product stance on global input fallback for production users?

## Subtasks

- Define `ComputerController`, `ComputerControlService`, result types, and ref
  storage.
- Implement helper resolution, setup diagnostics, and strict argv building.
- Implement payload ingestion for screenshot paths and annotated images.
- Implement observation, OCR, discovery, and first skill version.
- Implement app-targeted actions with verification.
- Implement wait, window, app, script, defaults, hover, drag, and global fallback
  gates.
- Add computer permission classes and ask copy.
- Build mocked `cu` fixtures covering every reference command.
- Add optional macOS smoke tests gated on helper availability.
- Update specs in the same PRs that ship behavior.
