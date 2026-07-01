# Agent Browser Control Tool

## Goal

Build a Tenon-native browser-use capability for the agent. The capability must
cover the full useful surface of `~/Coding/browser-pilot` while fitting Tenon's
agent runtime, permission model, event log, and multimodal tool-result pipeline.

The user-facing capability is the Browser Control tool family. It gives the
agent a dedicated, auditable browser session that can use the user's logged-in
browser state, observe pages, act on elements, upload files, capture screenshots
and PDFs, inspect cookies, switch tabs and frames, handle HTTP auth and dialogs,
and inspect or modify network traffic.

The critical product requirement is that visual results are first-class tool
results. A screenshot, annotated snapshot, or page capture is returned to the
model as image content and stored through payload refs. The agent must not have
to infer from a CLI file path that an image exists.

## Non-goals

- Do not expose a raw shell or CLI wrapper to the model.
- Do not make browser control a generic MCP dependency. The product surface is a
  Tenon-owned tool family backed by a replaceable browser backend.
- Do not replace simple `web_*` search/fetch tools. Browser control is for pages
  that need real browser state, interactivity, auth, frames, uploads,
  screenshots, PDFs, cookies, or network inspection.
- Do not add download management in the browser-pilot parity track.
  `browser-pilot` does not currently expose a download command; download
  handling should be a separate product decision if Tenon needs it later.
- Do not build an extension-only design. A Chrome DevTools Protocol backend is
  the reference implementation because it matches `browser-pilot`; an extension
  backend can implement the same interface later.
- Do not let the agent perform irreversible, outward-facing, credential,
  payment, account-security, or permission-changing actions without an explicit
  product safety decision.
- Do not persist browser screenshots, page text, cookies, or network bodies
  outside the existing event-log and payload-retention model.

## Shape

This plan is shape (b): a set of independently shippable complete features. Each
implementation unit must be useful and reviewable on its own, but the full plan
is the complete Browser Control capability.

## Collision Result

- `docs/plans/browser-extension-integration.md` is a record-only brainstorming
  document. This plan consumes and supersedes its Tier 2 "agent browser-control
  tool" direction once ratified. The old file remains useful background for the
  extension-vs-CDP tradeoff and for future capture reuse.
- PR #359, "Use linlab skills for bundled artifacts", has landed. Browser
  Control's built-in skill should use the resource-backed built-in skill
  mechanism in `docs/spec/agent-skills.md`: development loads from
  `src/main/builtInSkills` or enabled linlab roots, `bun run skills:sync` stages
  tracked files into `build/generated/built-in-skills`, and the packaged app
  loads them from `Resources/built-in-skills`.
- No active code PR was found claiming the Browser Control tool files. The future
  implementation will touch shared agent tool registration, permissions, and
  specs, so the first implementation PR should keep its interface changes tight
  and easy for sibling branches to rebase across.
- This plan intentionally does not edit `docs/TASKS.md`; that file is
  main-agent-owned.

## Reference Coverage

`browser-pilot` command coverage maps into a small Tenon-owned tool family:

| `browser-pilot` surface | Tenon surface |
|---|---|
| `connect`, `disconnect` | `browser_session` |
| `open` | `browser_open` |
| `snapshot`, `locate`, `read` | `browser_observe` |
| `click` | `browser_click` |
| `type`, `keyboard`, `press` | `browser_type`, `browser_keyboard`, `browser_press` |
| `eval` | `browser_eval` |
| `upload` | `browser_upload` |
| `screenshot`, `pdf`, `cookies` | `browser_capture` |
| `frame` | `browser_frame` |
| `auth` | `browser_auth` |
| `tabs`, `tab`, `close` | `browser_tabs` |
| `net list`, `net show`, `net block`, `net mock`, `net headers`, `net rules`, `net remove`, `net clear` | `browser_network` |
| popup discovery, JS dialogs, pilot overlay, load settling | backend behavior reported in tool results |

## Design

### Product Boundary

Browser Control is implemented as a first-party agent capability:

- Agent tool definitions stay concise and schema-oriented.
- Browser workflow guidance lives in a built-in `browser-control` skill.
- The tool implementation lives in Electron main, next to the existing agent
  tools, and uses the existing agent permission, event log, payload, and model
  content mechanisms.
- The backend is replaceable behind a `BrowserController` interface. The initial
  backend is CDP, modeled on `browser-pilot`. A future extension backend can
  serve capture and control through the same interface.

The agent never receives a path-only screenshot result. When a backend creates a
PNG, JPEG, PDF, HAR-like payload, request body, or response body, the main
process stores it as an event-log payload and exposes a typed payload ref. Images
that are useful to the model are also attached as model-visible image parts.

### Main-Process Architecture

Add a main-process `BrowserControlService` with these layers:

- `BrowserController`: backend-neutral interface used by tools.
- `CdpBrowserController`: initial implementation using Chrome DevTools Protocol.
- `BrowserSessionStore`: userData-scoped session metadata, target ids, current
  tab/frame, open network rules, and ephemeral ref maps.
- `BrowserSnapshotStore`: run-scoped AX/DOM snapshot refs keyed by
  `snapshotId`, `targetId`, `frameId`, and backend node ids.
- `BrowserPayloadWriter`: writes screenshots, PDFs, and network bodies through
  the existing event-log payload path.
- `BrowserPermissionAdapter`: maps browser operations to the existing permission
  classifier and ask resolver.

The service runs in Electron main. The renderer never talks to CDP directly and
never receives raw browser credentials, cookies, or response bodies unless they
are already normalized into tool-result payloads.

### Browser Discovery And Session Lifecycle

The CDP backend follows the `browser-pilot` model:

- Discover supported Chromium browsers by reading `DevToolsActivePort` from the
  user's browser profile or by using a configured debugging endpoint.
- Prefer a dedicated Pilot window or tab target so agent work is visibly
  separate from the user's active browsing.
- Support Chrome first, then Edge, Brave, and Chromium if their debugging endpoint
  and profile layout are compatible.
- Attach to an existing logged-in profile when the user has enabled remote
  debugging. Do not create a separate empty profile by default, because logged-in
  session reuse is the main value.
- Track target ids, popup targets, frame ids, and a current active frame.
- Inject a lightweight overlay only into Pilot targets so the user can see which
  tab is controlled by the agent.
- Wait for navigation using `document.readyState`, network/load events, and a
  short interactive grace period. Tool results include settling metadata instead
  of hiding slow-page uncertainty.

If CDP is unavailable, `browser_session` returns a setup result with exact
browser-specific remediation. It must not fail with a generic spawn error.

### Tool Surface

The tool family is intentionally compact, but not a single stringly-typed
megacommand.

| Tool | Purpose |
|---|---|
| `browser_session` | connect, status, disconnect, setup diagnostics, current target |
| `browser_open` | navigate current target or open a new Pilot target |
| `browser_observe` | accessibility snapshot, page text, selector location, optional annotated screenshot |
| `browser_click` | click by ref, selector, or coordinates; supports double and right click |
| `browser_type` | type into a target element; supports clear and submit |
| `browser_keyboard` | send raw text/key stream to the current focus or clicked target |
| `browser_press` | send named keys and shortcuts |
| `browser_eval` | run JavaScript in the current frame with strict permission gates |
| `browser_upload` | attach one or more local files to a file input |
| `browser_capture` | screenshot, full-page screenshot, selector screenshot, PDF, cookies |
| `browser_frame` | list frames and switch current frame context |
| `browser_auth` | set or clear HTTP Basic Auth credentials for matching origins |
| `browser_tabs` | list, switch, open, and close Pilot tabs |
| `browser_network` | inspect requests/responses and manage block/mock/header rules |

Each tool returns a standard envelope plus a model-visible concise projection.
The full raw result is retained as payload data when it is too large or sensitive
for the model-visible text.

### Result Protocol And Media

Every browser result has a stable outer shape:

```ts
type BrowserToolResult = {
  ok: boolean;
  sessionId: string;
  targetId?: string;
  frameId?: string;
  url?: string;
  title?: string;
  observationId?: string;
  snapshotId?: string;
  media?: BrowserMediaRef[];
  payloads?: BrowserPayloadRef[];
  warnings?: BrowserWarning[];
  nextActionHint?: string;
};
```

Media refs are event-log payload refs. Image media that should guide the next
model step is also attached to the tool result as image content. Large text,
network bodies, PDFs, and cookie dumps are stored as payloads and summarized in
the JSON text.

The model-visible part should be small:

- page identity, current frame, and current tab;
- the relevant AX/text excerpt or network summary;
- clickable refs and their names;
- verification status for actions;
- warnings such as stale refs, blocked popups, or redacted cookie values;
- image content for screenshots and annotated observations.

### Snapshot And Ref Model

`browser-pilot` persists refs in `~/.browser-pilot/refs.json`. Tenon should not.
Refs are run-scoped and snapshot-scoped:

- `browser_observe` returns a `snapshotId`.
- Element refs are only valid with that `snapshotId`.
- A ref resolves through CDP backend node ids when possible.
- Selector and coordinate actions remain available for cases where the AX tree is
  insufficient.
- If the page navigates, frame changes, or the backend node no longer resolves,
  the action fails with `stale_ref` and asks the agent to observe again.
- The event log stores the snapshot summary and payload refs, not an unbounded
  copy of every full AX tree.

The snapshot builder should preserve the strengths of `browser-pilot`:

- use `Accessibility.getFullAXTree`;
- include role, name, value, checked state, disabled state, focused state, and
  selected state when available;
- keep refs concise and stable within a snapshot;
- include frame and target context;
- generate an optional annotated screenshot for visual grounding.

### Observation

`browser_observe` supports:

- accessibility tree snapshot with refs;
- cleaned visible page text;
- selector location;
- current page metadata;
- current active/focused element;
- optional viewport or full-page screenshot;
- optional annotated screenshot with ref labels;
- current dialogs and popup targets;
- current frames, with the active frame identified.

The cleaned page text should use in-page scripts similar to
`browser-pilot`'s page helpers, but the final result must be normalized and size
limited before model exposure.

### Actions

Actions are implemented through CDP, not DOM-only scripts:

- Click uses resolved element rectangles, scrolls into view, avoids the overlay,
  and sends CDP input events. It supports single, double, and right click.
- Type handles standard inputs with a React-compatible value setter and
  `input`/`change` events, and handles contenteditable/rich editors with
  `Input.insertText`.
- `browser_keyboard` covers cases where the target is canvas, Google Docs-like,
  Figma-like, or otherwise not a normal DOM input.
- `browser_press` supports named keys and shortcuts.
- Upload resolves file inputs and sets local files through CDP. File access uses
  the existing local-file permission boundary.
- Frame switching changes the default execution context for later observe/action
  calls.
- Tab actions are limited to Pilot-owned tabs unless an explicit future product
  decision allows adopting arbitrary user tabs.

Every action can request a post-action observation. Mutating actions default to a
small verification snapshot or screenshot so the next model step has grounded
state.

### JavaScript Evaluation

`browser_eval` covers the `browser-pilot eval` capability, including awaited
Promises and current-frame execution. It is high risk:

- It requires a separate permission classification from normal observation and
  clicks.
- Results are JSON-serialized and size limited.
- DOM nodes and binary objects are summarized, not exposed raw.
- It must not be the default path for normal actions if a dedicated tool exists.
- It is allowed for debugging, extraction, and one-off site automation only after
  the permission stack has made that explicit to the user.

### Capture, Cookies, And Files

`browser_capture` covers:

- viewport screenshot;
- full-page screenshot;
- selector screenshot;
- PDF print output;
- cookie listing for the current site or an explicit domain.

Screenshots return image content. PDFs return payload refs, and the UI may show a
preview through the existing file-preview path if available. Cookie values are
redacted in the model-visible summary by default; full values require a separate
permission and are still stored as sensitive payloads.

### Network Control

`browser_network` covers the full `browser-pilot net` surface:

- list recent requests with filters for URL, method, status, resource type, and
  `afterRequestId` / cursor semantics matching `browser-pilot net --after`;
- show request and response details by id;
- save or expose bodies as payload refs when large or binary;
- block matching URL patterns;
- mock matching URL patterns with status, headers, and inline or file-backed
  bodies;
- add request headers for matching patterns;
- list active rules;
- remove one rule or clear all rules.

Network rules are session-scoped by default and cleared when the Browser Control
session disconnects unless the user explicitly asks to persist them. Rule results
must identify which requests were intercepted or modified.

### Auth, Dialogs, And Popups

The backend tracks:

- HTTP Basic Auth challenges, with `browser_auth` able to set or clear
  credentials for matching origins;
- JavaScript dialogs, reported in tool results;
- popup targets discovered from CDP target events.

Dialog handling should be explicit. The backend can auto-acknowledge harmless
alerts to keep automation moving, but confirm/prompt behavior must be controlled
by tool args and permission policy. Tool results always report handled dialogs.

### Permission Model

Browser permissions are operation-specific:

- read page state;
- capture screen or PDF;
- read cookies;
- read request and response bodies;
- mutate page state through clicks, typing, upload, key events, or tab closing;
- run JavaScript;
- modify network traffic;
- provide auth credentials.

The permission classifier should consider host, action kind, target label,
button text, form context, and whether the action appears outward-facing. A
future hard-prohibition list must be decided before implementation for payments,
credential entry, access-control changes, destructive account changes, and other
irreversible actions.

### Built-In Skill

Add a built-in `browser-control` skill. This is the clean way to avoid bloated
tool descriptions.

The tool definitions should contain:

- concise purpose;
- input schema;
- safety notes that directly affect permission classification;
- result shape.

The skill should contain:

- when to use browser control instead of `web_*` tools;
- the observe-then-act loop;
- how snapshot refs and stale refs work;
- recipes for login sessions, iframes, popups, file upload, rich editors,
  screenshots, PDFs, cookies, and network debugging;
- when to use `browser_eval`;
- anti-patterns, including blind coordinate clicks, repeated actions without
  re-observing, using eval when a typed tool exists, and acting in non-Pilot tabs.

The skill should be loaded when the model receives or elects to use browser
tools. Detailed workflows belong there, not in every tool's description.

### Specs And Documentation

Update the current specs in the same implementation PRs:

- `docs/spec/agent-tool-design.md`: tool registry, permission classes, result
  examples, and the Browser Control family.
- `docs/spec/agent-event-log-rendering.md`: image and payload treatment for
  browser screenshots, PDFs, and network bodies.
- `docs/spec/agent-pi-mono-implementation.md`: browser controller as a
  main-process tool implementation, not a renderer bridge.
- `docs/spec/agent-progress.md`: progress checklist for Browser Control.
- `docs/spec/agent-skills.md`: Browser Control skill as a resource-backed
  built-in staged by `bun run skills:sync` and packaged under
  `Resources/built-in-skills`.

## Implementation Units

### Unit 1: Read-Only Browser Session And Visual Observation

Complete feature: the agent can connect to a supported browser, open a Pilot tab,
observe page structure, read visible text, list frames and tabs, and return
screenshots as image tool results.

Scope:

- `BrowserController` and `CdpBrowserController` foundation;
- browser discovery and setup diagnostics;
- `browser_session`, `browser_open`, `browser_observe`, `browser_frame` list,
  `browser_tabs` list/switch, and screenshot mode of `browser_capture`;
- snapshot/ref store;
- first version of `browser-control` skill focused on observation;
- specs and tests for image payloads, stale refs, missing browser setup, frame
  listing, and no binary data in JSONL state.

### Unit 2: Safe Page Actions

Complete feature: the agent can act on normal web pages in a dedicated Pilot tab
with verification and permission gates.

Scope:

- `browser_click`, `browser_type`, `browser_keyboard`, `browser_press`,
  `browser_upload`;
- tab close/open in Pilot-owned tabs;
- frame switching;
- dialog and popup reporting;
- post-action verification snapshots;
- rich input handling for standard inputs, contenteditable, and common React
  controlled inputs;
- tests adapted from `browser-pilot` for click, type, clear, submit, key press,
  upload, dialogs, popups, frames, shadow DOM, scroll-to-click, and overlay
  avoidance.

### Unit 3: Capture, Cookies, Eval, Auth, And Network Debugging

Complete feature: the agent has the full advanced browser-pilot capability
surface with stronger permissions and payload handling.

Scope:

- PDF capture and selector/full-page screenshots;
- cookies with redaction and sensitive-payload policy;
- `browser_eval`;
- `browser_auth`;
- `browser_network` list/show/block/mock/headers/rules/remove/clear;
- payload storage for large or binary request/response bodies;
- high-risk permission classes and user-facing ask copy;
- tests for PDF payloads, cookie redaction, eval permissions, Basic Auth,
  network monitoring, blocking, mocking, header injection, and rule cleanup.
  Include incremental network listing through `afterRequestId` / cursor coverage.

### Unit 4: Extension-Compatible Backend Seam

Complete feature: Browser Control can keep using CDP, while capture and future
extension work can depend on the same controller contract without duplicating
tab addressing, permissions, or payload semantics.

Scope:

- finalize the backend-neutral `BrowserController` interface;
- document how an extension backend maps tab ids to the same session/target
  model;
- connect the existing `PageContentExtractor` seam to the read subset where it
  makes sense;
- add contract tests that run against a fake controller so future backends cannot
  diverge from Browser Control result shapes.

## Validation

Validation should combine unit tests, integration tests, and a serial browser
test suite:

- mocked CDP tests for permission classification, result normalization, payload
  writing, and stale-ref handling;
- Playwright-hosted fixture pages for forms, contenteditable, file upload, shadow
  DOM, iframes, popups, dialogs, network interception, screenshots, PDFs, and
  cookies;
- optional real-browser smoke tests gated on a local debugging endpoint;
- event-log tests proving screenshots are payload-backed and model-visible as
  image parts;
- security tests proving high-risk operations ask before running;
- regression tests for no raw binary in JSONL or React state.

## Open Questions

- Which Chromium browsers are supported in the first implementation: Chrome only,
  or Chrome plus Edge/Brave/Chromium?
- Should Tenon provide a guided remote-debugging setup flow, or only diagnostics
  and copyable instructions?
- Can the agent adopt the user's currently active tab, or must all acting stay
  inside Pilot-owned tabs until a later product decision?
- What is the final hard-prohibition list for browser actions, even with user
  approval?
- Is `browser_eval` available to all agent modes, or only to a developer/debug
  mode?
- Should network rules ever persist across sessions, or always remain
  session-scoped?

## Subtasks

- Define `BrowserController`, `BrowserControlService`, and result types.
- Implement CDP discovery and session attach.
- Implement Pilot target creation and overlay injection.
- Implement snapshot/ref storage with stale-ref detection.
- Implement image and binary payload helpers for browser results.
- Implement read-only tools and first skill version.
- Implement action tools and verification.
- Implement capture, cookies, auth, eval, and network tools.
- Add browser permission classes and ask copy.
- Port the relevant `browser-pilot` test matrix into Tenon integration tests.
- Update specs in the same PRs that ship behavior.
