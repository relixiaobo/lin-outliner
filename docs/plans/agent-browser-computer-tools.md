---
status: draft
priority: P1
owner: relixiaobo
created: 2026-05-28
updated: 2026-05-28
---

# Agent Browser and Computer Tools

Design contract for giving Lin's agent controlled access to the user's browser
and desktop. This is a forward-looking plan. When implemented, the shipped
contract should move into `docs/spec/agent-tool-design.md`.

## Goal

Give the agent two explicit external-control capabilities:

- **Browser control**: operate the user's real Chromium browser profile through
  Chrome DevTools Protocol (CDP), preserving the user's login sessions,
  cookies, extensions, and normal browser configuration.
- **Computer control**: operate macOS applications through the cheapest reliable
  layer available: app scripting first, accessibility tree and native events
  second, OCR/screenshot last.

The core contract is not "click things on screen." It is a closed loop:

1. Observe a structured state.
2. Act against a short-lived reference, stable selector, or explicit target.
3. Return a fresh state plus a delivery `method`.
4. Surface degraded, ambiguous, or unverifiable output as explicit strings the
   agent must read.

This plan is based on the actual `browser-pilot` and `computer-pilot`
implementations under `/Users/lixiaobo/Coding/`, not on a generic browser or
desktop automation abstraction.

`browser-pilot` and `computer-pilot` are the **primary implementation
references**. Their control loops, routing layers, result fields, failure
strings, and verification behavior define the core design. `lin-agent` and
`sider-agent` are secondary references for product-facing tool shape, skill
packaging, and prompt/tool-result ergonomics.

## Non-goals

- Do not merge browser and desktop control into one generic `click/type`
  surface. Browser pages are structured by CDP/DOM/AX; desktop apps are
  structured by AppleScript, AX, native events, screenshots, and OCR.
- Do not use desktop coordinate automation as the default way to control web
  pages.
- Do not promise stable numeric refs across actions.
- Do not make `eval`, OCR, or screenshots the default read path when a
  structured read exists.
- Do not vendor Rust, Cargo, Tauri, or `src-tauri` runtime code into Lin.
  Product code remains TypeScript/Electron. A user-installed external CLI can be
  an optional adapter for prototyping, but the Lin product contract must not
  depend on Rust code living in this repository.
- Do not expose these tools in the default P0 tool set before the permission
  model and approval UI can represent their risk. They should be capability
  gated.

## Reference Findings

### Primary Implementation References

#### Browser Pilot

Reference paths:

- `/Users/lixiaobo/Coding/browser-pilot/src/cli.ts`
- `/Users/lixiaobo/Coding/browser-pilot/src/session.ts`
- `/Users/lixiaobo/Coding/browser-pilot/src/daemon.ts`
- `/Users/lixiaobo/Coding/browser-pilot/src/snapshot.ts`
- `/Users/lixiaobo/Coding/browser-pilot/src/page-scripts.ts`
- `/Users/lixiaobo/Coding/browser-pilot/plugin/skills/browser-pilot/SKILL.md`

The actual control path is:

```txt
agent
  -> bp CLI
  -> local daemon over ~/.browser-pilot/daemon.sock
  -> one persistent CDP WebSocket
  -> user's real Chrome / Brave / Edge profile
  -> agent-owned pilot window and tabs
```

Important implementation details to preserve:

- `connect` discovers a Chromium `DevToolsActivePort` file, starts a daemon,
  creates a new pilot window, attaches to the target, enables `Page`, and
  injects a visible border overlay.
- The daemon owns long-lived state that should outlive a single command:
  dialogs, discovered popup targets, HTTP auth credentials, network logs, and
  request interception rules.
- Snapshot uses `Accessibility.getFullAXTree`, walks the AX tree in document
  order, and assigns sequential refs to interactive roles only. It stores
  `backendDOMNodeId` out-of-band in `refs.json`, scoped to `targetId`; the model
  sees only lean `ref/role/name/value/checked` data.
- Ref click resolves the stored backend node with `DOM.resolveNode`, calls an
  injected function that `scrollIntoView`s the element and returns its center,
  then dispatches CDP mouse events.
- Standard input typing uses a React-compatible value setter and fires
  `input`/`change`. Contenteditable typing uses focus/selection helpers and
  `Input.insertText`. Canvas editors use real keyboard events through
  `keyboard`, optionally after a CSS-selector click.
- `read` is a first-class page-content reader. It clones `main/article/body`,
  drops scripts/styles/nav/footer/aside/hidden content, collapses whitespace,
  and truncates. This exists to prevent the agent from overusing `eval` for
  ordinary page reading.
- `eval` is deliberately an escape hatch for structured extraction or page
  control that no narrower command covers.
- Frames are explicit state: `frame 1` creates an isolated world and stores a
  `frameContextId` so later `eval/read` calls run in that iframe.
- Network functionality belongs in the daemon, not stateless CLI calls:
  `Network.*` events populate an in-memory request log; `Fetch.*` handles
  block/mock/header rules and HTTP auth; each command ensures network tracking
  is enabled for the active session.
- Popups are discovered via `Target.setDiscoverTargets`, then adopted into the
  pilot tab list. Agent tabs are separated from arbitrary user tabs by the
  stored `pilotTargetIds`.

The transferable lesson is that browser control should be a CDP session
manager plus a small page-action protocol. The agent should not manipulate the
browser through global desktop events when CDP can express the action.

#### Computer Pilot

Reference paths:

- `/Users/lixiaobo/Coding/computer-pilot/src/main.rs`
- `/Users/lixiaobo/Coding/computer-pilot/src/ax.rs`
- `/Users/lixiaobo/Coding/computer-pilot/src/mouse.rs`
- `/Users/lixiaobo/Coding/computer-pilot/src/key.rs`
- `/Users/lixiaobo/Coding/computer-pilot/src/screenshot.rs`
- `/Users/lixiaobo/Coding/computer-pilot/src/observer.rs`
- `/Users/lixiaobo/Coding/computer-pilot/plugin/skills/computer-pilot/SKILL.md`
- `/Users/lixiaobo/Coding/computer-pilot/plugin/skills/computer-pilot/references/method_field.md`

The actual control model is:

```txt
Tier 1: AppleScript / defaults
  -> direct app data or system preference access

Tier 2: AX tree + native actions / CGEvent
  -> refs, axPath, AXPress/AXConfirm/AXOpen, AXValue, PID-targeted events

Tier 3: OCR + screenshot
  -> Vision text regions, ScreenCaptureKit/CGWindow screenshots, coordinate fallback
```

Important implementation details to preserve:

- `state <app>` is the canonical task start. It returns AX snapshot, windows,
  displays, screenshot path or `screenshot_error`, and frontmost state in one
  round trip.
- Snapshot resolves the target window through AX (`AXFocusedWindow`,
  `AXMainWindow`, `_AXUIElementGetWindow`) before screenshot capture. This
  avoids the CGWindowList "first/largest window" identity bug that the project
  explicitly documents as an anti-pattern.
- Snapshot elements include `ref`, `role`, `title`, `value`, geometry, and a
  stable `axPath`. It also surfaces `focused`, `modal`, `truncated`, and
  `truncation_hint`.
- Numeric refs are ephemeral DFS counters. `axPath` is the stable selector for
  multi-step flows.
- `click` has multiple modes: `--ax-path`, OCR text, coordinates, and ref.
  Ref click first runs an AX action chain (`AXPress`, `AXConfirm`, `AXOpen`,
  child/parent/ancestor actions, toggles, selection) and only falls back to
  CGEvent if AX cannot perform the action.
- All state-changing actions attach `method`, and `method` maps to
  `confidence`/`advice`. `ax-action`, `ax-set-value`, and `ax-perform` are best
  because they do not move focus or cursor. `*-pid` is non-disruptive native
  event delivery. `*-global` is a warning sign.
- `--app` is the focus boundary. With `--app`, mouse and keyboard events are
  posted to the target process via `CGEventPostToPid` using a combined-session
  event source. Without it, events go through the global HID tap and can hit the
  terminal or frontmost app.
- `type` uses Unicode CGEvents by default, but auto-routes through clipboard
  paste for CJK text and known chat apps. The response includes `paste_reason`
  so the agent can see the route changed.
- `click` verifies by default. It snapshots before the action, attaches a
  post-action snapshot, diffs the AX tree, and returns `verified`,
  `verify_diff`, and `verify_advice` when the tree did not change.
- A stale-ref guard compares the current ref identity against the cached last
  snapshot and emits `stale_state_advice` when the UI shifted.
- Post-action snapshot timing is not a blind sleep. `observer::wait_for_settle`
  subscribes to AX notifications such as `AXValueChanged` and
  `AXFocusedUIElementChanged`, returning early when the UI changes and capping
  at 500 ms.
- Screenshot capture uses ScreenCaptureKit first, with CGWindowList fallback.
  Capture-protected windows (`kCGWindowSharingState=0`) fail loudly with a
  structured error instead of returning a misleading blank image.
- OCR returns confidence fields and `confidence_hint` when any recognition is
  low confidence.

The transferable lesson is that desktop control needs routing transparency and
recovery strings. A response that only says `ok: true` is not enough for an
agent.

### Secondary Tool-Surface References

The projects below inform how the model-facing tool should be packaged, how
skills should be paired with tools, and how browser tab ownership should be
explained. They do not replace the `browser-pilot` / `computer-pilot`
implementation architecture as the core reference.

#### Lin Agent

Reference paths:

- `/Users/lixiaobo/Coding/lin-agent/src/main/tools/browser-action.ts`
- `/Users/lixiaobo/Coding/lin-agent/src/main/kernel/browser/action-types.ts`
- `/Users/lixiaobo/Coding/lin-agent/src/main/kernel/browser/action-registry.ts`
- `/Users/lixiaobo/Coding/lin-agent/src/main/kernel/browser/snapshot.ts`
- `/Users/lixiaobo/Coding/lin-agent/src/main/kernel/browser/interaction-actions.ts`
- `/Users/lixiaobo/Coding/lin-agent/docs/decisions/0015-browser-automation-tier-strategy.md`
- `/Users/lixiaobo/Coding/lin-agent/docs/decisions/0030-browser-tool-surface-redesign.md`
- `/Users/lixiaobo/Coding/lin-agent/docs/browser-action-implementation.md`
- `/Users/lixiaobo/Coding/lin-agent/docs/decisions/0009-no-computer-use-v1.md`

The actual browser control path is:

```txt
agent
  -> BrowserAction tool
  -> BrowserController
  -> Electron WebContentsView tabs
  -> hidden offscreen BaseWindow or visible BrowserPanel
```

Important implementation details to preserve:

- The model-facing browser surface is one tool, `BrowserAction`, with a typed
  `action` union. It is not a set of many model-facing `BrowserX` tools.
- The action list includes observation, interaction, tab/session, and browser
  parity operations: `state`, `navigate`, `tab`, `snapshot`, `find`, `read`,
  `click`, `type`, `press`, `scroll`, `wait`, `screenshot`, `eval`, `session`,
  `network`, `console`, `download`, `upload`, `dialog`, `permission`,
  `certificate`, `frame`, `environment`, `hover`, `drag`, `media`, and `pdf`.
- The implementation uses action-specific schemas and details types. The
  public tool is single, but action contracts still carry validation,
  permission scope, read-only classification, concurrency safety, result
  budgets, model-facing content mapping, and telemetry details.
- `snapshot` returns interactive refs, not article text. `read` returns page
  content, not refs. `find` returns snippets when the model needs text matches
  without pulling the full page.
- `type` types text only. Submission is a separate `press Enter` action. The
  ADR explicitly rejects hiding type-plus-submit behind a boolean.
- `click`, `type`, `press`, and `scroll` can return compact post-action
  snapshots so the model does not have to guess whether to observe next.
- BrowserPanel visibility is a common parameter, not a standalone model-facing
  tool. The default is hidden background work; the panel is shown only for user
  inspection, login, or handoff.
- Electron-native input and capture are preferred for embedded browser tabs.
  CDP is reserved for cases Electron cannot cover: full-page screenshot,
  upload/drag, JavaScript dialogs, response-body rewrite/mock, and IME/touch
  if needed.
- `lin-agent` deliberately rejected local Computer Use for v1. ADR 0009
  classifies it as a later, higher-risk product layer requiring OS
  permissions, per-app trust zones, operation narration, and replay logs.

The transferable lesson is that a single model-facing browser tool is fine only
when the runtime still treats each action like a real tool internally. Lin
Outliner should copy the action-contract discipline, not just the one-tool
shape. For browser transport, Lin Outliner differs from `lin-agent`: this plan
targets the user's real Chromium profile through CDP, so the provider must not
assume Electron `WebContentsView`, even though the model-facing action contract
can stay similar.

#### Sider Agent

Reference paths:

- `/Users/lixiaobo/Coding/sider-agent/src/lib/ai-tools/browser-tool.ts`
- `/Users/lixiaobo/Coding/sider-agent/src/lib/ai-tools/browser-actions/observation.ts`
- `/Users/lixiaobo/Coding/sider-agent/src/lib/ai-tools/browser-actions/interaction.ts`
- `/Users/lixiaobo/Coding/sider-agent/src/lib/ai-tools/browser-actions/deep-interaction.ts`
- `/Users/lixiaobo/Coding/sider-agent/src/lib/ai-tools/browser-actions/shared.ts`
- `/Users/lixiaobo/Coding/sider-agent/src/lib/ai-tools/result-builder.ts`
- `/Users/lixiaobo/Coding/sider-agent/src/lib/ai-tools/skill-tool.ts`
- `/Users/lixiaobo/Coding/sider-agent/src/lib/ai-tab-context.ts`
- `/Users/lixiaobo/Coding/sider-agent/src/entrypoints/background/index.ts`
- `/Users/lixiaobo/Coding/sider-agent/src/assets/skills/web/SKILL.md`
- `/Users/lixiaobo/Coding/sider-agent/src/assets/skills/web/libraries.json`

The actual browser control path is:

```txt
agent
  -> single browser tool
  -> Chrome extension side panel/service worker
  -> user's real Chrome tabs
  -> CDP, chrome.scripting, and extension APIs
```

Important implementation details to preserve:

- The model-facing surface is one tool named `browser`, with an `action`
  parameter. Actions cover `get_text`, `get_metadata`, `find`, `get_selection`,
  `screenshot`, `read_network`, `read_console`, `click`, `type`, `key`,
  `scroll`, `drag`, `fill_form`, `navigate`, `tab`, `wait`, `execute_js`, and
  `attach_file`.
- Sider uses one flat parameter object with many optional fields. This works
  for a browser extension MVP, but it makes invalid cross-action combinations
  easier. Lin should keep Sider's one-tool principle but use discriminated
  unions for stronger validation.
- The tool description is unusually forceful about ownership: the user's tab is
  not the agent's tab. Multi-step research should create dedicated agent tabs
  in a workspace/tab group and then pass `tabId` to every later action.
- `tab create` accepts a workspace slug so all tabs for a task land in one
  visible, collapsible Chrome group. If the model forgets the workspace, Sider
  auto-falls back to a session task group instead of scattering tabs through
  the user's strip.
- Observation result text explains that the model sees the data but the user
  usually only sees a brief tool log. Mutation result text explains when the
  user sees an inline screenshot and should not be given a pixel-by-pixel
  narration.
- Result prose has three useful channels: status, user visibility, and
  instructions. Structured payload stays in `details`; the model-facing
  `content` is deliberately written for next-step behavior.
- Mutation actions auto-capture a screenshot when possible. If screenshot
  capture fails, the result says so explicitly so the model knows the user lacks
  visual confirmation.
- `execute_js` is read-only by default. A `screenshot` flag opts into visual
  confirmation when the script mutates page state.
- Before every `execute_js`, the extension injects a native input bridge:
  `nativeType`, `nativePress`, `nativeClick`, `nativeKeyDown`, and
  `nativeKeyUp`. Site-specific libraries use this bridge for pages like Google
  Sheets and WhatsApp where `Input.insertText` bypasses important key events.
- The `web` skill is paired with the browser tool. It provides generic web
  methodology plus per-site libraries, and `libraries.json` maps URL patterns
  to auto-injected JavaScript namespaces such as `window.sheets`,
  `window.whatsapp`, `window.linkedin`, and `window.x`.
- Per-turn tab context is pushed as a small reminder: active tab every turn,
  tab diffs only when changed, full tab list only on demand through the tool.

The transferable lesson is that Browser should be one tool, but it still needs
an explicit tab/workspace ownership model and a paired Web skill. Lin
Outliner's browser contract should default to agent-owned browser tabs in the
user's profile, not to clobbering whichever tab the user happened to have
active.

Sider does not implement local user-machine Computer Use. Its `desktop` notes
refer to Cloudflare Sandbox/Xvfb VM automation, which is a different product
boundary from controlling the user's Mac. Therefore the computer contract in
this plan should continue to follow `computer-pilot` rather than Sider.

## Shared Lin Tool Result Contract

Lin already has `ToolEnvelope<TData>`:

```ts
interface ToolEnvelope<TData = unknown> {
  ok: boolean;
  tool: string;
  version: 1;
  status: "success" | "partial" | "unchanged" | "denied" | "error";
  data?: TData;
  error?: ToolError;
  instructions?: string;
  warnings?: string[];
  metrics?: ToolMetrics;
}
```

Browser and computer tools must use this envelope. Pilot-style fields map as
follows:

| Pilot concept | Lin field |
| --- | --- |
| `ok` | `ok` |
| command-specific payload | `data` |
| `hint`, `advice`, `verify_advice`, `truncation_hint`, `confidence_hint`, `paste_reason`, `screenshot_error`, `stale_state_advice` | keep as explicit string fields inside `data`; also summarize the highest-priority next step in `instructions` |
| `method` | `data.method` |
| `confidence` | `data.confidence` |
| `settle_ms` | `data.settleMs` and `metrics.durationMs` where appropriate |
| auto-attached `snapshot` | `data.snapshot` |

Do not collapse all advisory strings into one generic `instructions` field.
The pilots intentionally use named string fields because agents notice
surprising explicit fields more reliably than booleans.

Shared data shapes:

```ts
type ControlConfidence = "high" | "medium" | "low";

interface ControlActionMeta {
  method: string;
  confidence: ControlConfidence;
  advice?: string;
  settleMs?: number;
}

interface ControlElement {
  ref: number;
  role: string;
  name?: string;
  title?: string;
  value?: string;
  checked?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  stablePath?: string;
}

interface ControlSnapshot {
  snapshotId: string;
  targetId: string;
  targetKind: "browser_page" | "desktop_app";
  elements: ControlElement[];
  truncated: boolean;
  truncationHint?: string;
}
```

Lin should add `snapshotId` even though the reference CLIs mostly rely on local
state files and caches. `snapshotId` lets the tool gateway warn when an action
uses refs from an older state than the latest observed state.

## Tool Definition Strategy

Lin should expose exactly **two model-facing tools**:

- `browser`
- `computer`

Each tool has a required `action` field and a strict action-specific parameter
shape. This keeps the model-facing tool list small while preserving the
reference projects' carefully separated verbs.

Reasoning from the references:

- The pilots expose many CLI subcommands because command-line UX benefits from
  discoverable verbs. Lin's agent tool list is prompt context; a long tool list
  makes the base agent harder to steer.
- The implementation architecture should stay anchored in the two pilots:
  `browser-pilot` for real Chromium CDP session management, AX snapshots,
  refs, page actions, frames, network/auth/cookies/upload; `computer-pilot` for
  script/defaults -> AX/native -> OCR/screenshot routing, `method`,
  confidence, verification, stale-state, and capture-protection fields.
- `lin-agent` and `sider-agent` both converge on one model-facing browser tool
  with many action values. This validates the one-tool browser shape for a
  product agent, even though their transports differ.
- The pilots still prove that verbs must remain semantically distinct. `read`
  is not `snapshot`; `type` is not `keyboard`; `set-value` is not `type`;
  `tell` is not `click`. In Lin, those distinctions live in the `action` union
  and in the companion skill.
- Sider's flat optional parameter bag is useful evidence for the prompt shape,
  but Lin should not copy it literally. A loose `{ action: string, args:
  object }` or many-optional-fields schema would lose validation and permission
  clarity. Lin must use discriminated unions so the runtime validates exactly
  one action shape and classifies permission from typed parameters.
- `lin-agent` shows the runtime must still have per-action contracts under the
  one public tool: validation, permission scope, read-only classification,
  concurrency, result budget, model content, telemetry, and recovery hints.
- Permission and audit UX becomes clearer with two domain tools: "Browser wants
  to run `eval` on github.com" and "Computer wants to click in Finder" are both
  one tool plus one action, not dozens of unrelated tool names.
- For browser action names, prefer the names that `lin-agent` and `sider-agent`
  share where possible: `navigate`, `tab`, `read`, `find`, `click`, `type`,
  `press/key`, `scroll`, `wait`, `screenshot`, `eval/execute_js`, `network`,
  and `console`. Browser-pilot command names remain the implementation mapping.

The shape is:

1. **Model-facing tools**: `browser` and `computer`.
2. **Action unions**: each action has its own required/optional fields and
   validation.
3. **Capability gates**: advanced actions are disabled until the user request,
   permission state, or loaded skill enables them.
4. **Internal action contracts**: do not collapse implementation into a bare
   `switch(action)`. Every action spec owns validation, permission, concurrency
   locks, result slimming, and model-facing content.
5. **Internal provider operations**: connect, resume, cache refs, verify,
   settle, diff, audit, and attach snapshots are not separate model-facing
   tools unless the user explicitly asks for session control.

### Canonical JSON Schemas

These are the model-facing tool definitions. They are deliberately two tools,
not many small browser/computer tools. The implementation still dispatches to
per-action contracts internally.

The schemas use JSON Schema `oneOf` with an `action` constant to express the
discriminated union. Cross-field constraints that are awkward in model-tool
schemas, such as "exactly one target mode" and permission-gated advanced
actions, must also be enforced by the runtime before execution.

```json
{
  "name": "browser",
  "description": "Operate agent-owned tabs in the user's approved Chromium browser profile. Use this for live browser state, logged-in pages, page interaction, screenshots, frames, network/debug inspection, uploads, cookies, and browser-session work. Do not use it for ordinary URL fetching when a non-live fetch tool can answer the task. Do not overwrite the user's active non-agent tab unless the user explicitly targeted it.",
  "input_schema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "oneOf": [
      { "$ref": "#/$defs/state" },
      { "$ref": "#/$defs/navigate" },
      { "$ref": "#/$defs/tab" },
      { "$ref": "#/$defs/metadata" },
      { "$ref": "#/$defs/read" },
      { "$ref": "#/$defs/find" },
      { "$ref": "#/$defs/selection" },
      { "$ref": "#/$defs/snapshot" },
      { "$ref": "#/$defs/click" },
      { "$ref": "#/$defs/type" },
      { "$ref": "#/$defs/press" },
      { "$ref": "#/$defs/keyboard" },
      { "$ref": "#/$defs/scroll" },
      { "$ref": "#/$defs/wait" },
      { "$ref": "#/$defs/screenshot" },
      { "$ref": "#/$defs/session" },
      { "$ref": "#/$defs/eval" },
      { "$ref": "#/$defs/network" },
      { "$ref": "#/$defs/console" },
      { "$ref": "#/$defs/download" },
      { "$ref": "#/$defs/pdf" },
      { "$ref": "#/$defs/upload" },
      { "$ref": "#/$defs/auth" },
      { "$ref": "#/$defs/cookies" },
      { "$ref": "#/$defs/frame" },
      { "$ref": "#/$defs/environment" }
    ],
    "$defs": {
      "xy": {
        "type": "object",
        "required": ["x", "y"],
        "additionalProperties": false,
        "properties": {
          "x": { "type": "number" },
          "y": { "type": "number" }
        }
      },
      "tabId": {
        "type": "string",
        "description": "Agent-owned browser tab id. Omit to target the current agent-owned tab."
      },
      "state": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "state" },
          "include": {
            "type": "array",
            "items": { "enum": ["tabs", "active", "workspaces", "blockers", "debug"] },
            "uniqueItems": true
          }
        }
      },
      "navigate": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "navigate" },
          "op": { "enum": ["open", "back", "forward", "reload", "hard_reload", "stop"], "default": "open" },
          "url": { "type": "string", "description": "Required for op=open." },
          "target": { "enum": ["current", "new"], "default": "current" },
          "workspace": { "type": "string", "description": "Agent workspace slug for new agent-owned tabs." },
          "tabId": { "$ref": "#/$defs/tabId" },
          "waitUntil": { "enum": ["interactive", "complete"] },
          "snapshotLimit": { "type": "integer", "minimum": 0, "maximum": 200, "default": 50 }
        }
      },
      "tab": {
        "type": "object",
        "required": ["action", "op"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "tab" },
          "op": { "enum": ["list", "create", "switch", "close"] },
          "url": { "type": "string" },
          "workspace": { "type": "string" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "active": { "type": "boolean", "default": true },
          "snapshotLimit": { "type": "integer", "minimum": 0, "maximum": 200 }
        }
      },
      "metadata": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "metadata" },
          "tabId": { "$ref": "#/$defs/tabId" }
        }
      },
      "read": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "read" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "selector": { "type": "string" },
          "offset": { "type": "integer", "minimum": 0, "default": 0 },
          "maxChars": { "type": "integer", "minimum": 1, "maximum": 100000, "default": 30000 }
        }
      },
      "find": {
        "type": "object",
        "required": ["action", "query"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "find" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "query": { "type": "string", "minLength": 1 },
          "context": { "type": "integer", "minimum": 0, "maximum": 2000, "default": 500 },
          "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 },
          "matchOffset": { "type": "integer", "minimum": 0, "default": 0 }
        }
      },
      "selection": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "selection" },
          "tabId": { "$ref": "#/$defs/tabId" }
        }
      },
      "snapshot": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "snapshot" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "filter": { "enum": ["interactive", "all"], "default": "interactive" },
          "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
        }
      },
      "click": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": false,
        "oneOf": [
          { "required": ["ref"] },
          { "required": ["selector"] },
          { "required": ["xy"] }
        ],
        "properties": {
          "action": { "const": "click" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "ref": { "type": "integer", "minimum": 1 },
          "snapshotId": { "type": "string" },
          "selector": { "type": "string" },
          "xy": { "$ref": "#/$defs/xy" },
          "button": { "enum": ["left", "right", "middle"], "default": "left" },
          "clickCount": { "enum": [1, 2], "default": 1 },
          "snapshotLimit": { "type": "integer", "minimum": 0, "maximum": 200, "default": 50 }
        }
      },
      "type": {
        "type": "object",
        "required": ["action", "text"],
        "additionalProperties": false,
        "oneOf": [
          { "required": ["ref"] },
          { "required": ["selector"] }
        ],
        "properties": {
          "action": { "const": "type" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "ref": { "type": "integer", "minimum": 1 },
          "snapshotId": { "type": "string" },
          "selector": { "type": "string" },
          "text": { "type": "string" },
          "clear": { "type": "boolean", "default": false },
          "snapshotLimit": { "type": "integer", "minimum": 0, "maximum": 200, "default": 50 }
        }
      },
      "press": {
        "type": "object",
        "required": ["action", "key"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "press" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "key": { "type": "string", "description": "Enter, Escape, Control+a, Meta+c, Shift+Enter, etc." },
          "ref": { "type": "integer", "minimum": 1 },
          "snapshotId": { "type": "string" },
          "selector": { "type": "string" },
          "snapshotLimit": { "type": "integer", "minimum": 0, "maximum": 200, "default": 50 }
        }
      },
      "keyboard": {
        "type": "object",
        "required": ["action", "text"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "keyboard" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "text": { "type": "string" },
          "clickSelector": { "type": "string" },
          "clear": { "type": "boolean", "default": false },
          "delayMs": { "type": "integer", "minimum": 0, "maximum": 5000 },
          "snapshotLimit": { "type": "integer", "minimum": 0, "maximum": 200, "default": 50 }
        }
      },
      "scroll": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "scroll" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "ref": { "type": "integer", "minimum": 1 },
          "snapshotId": { "type": "string" },
          "selector": { "type": "string" },
          "direction": { "enum": ["up", "down", "left", "right", "top", "bottom"], "default": "down" },
          "amount": { "type": "integer", "minimum": 1 },
          "snapshotLimit": { "type": "integer", "minimum": 0, "maximum": 200, "default": 50 }
        }
      },
      "wait": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": false,
        "oneOf": [
          { "required": ["selector"] },
          { "required": ["urlPattern"] },
          { "required": ["durationMs"] }
        ],
        "properties": {
          "action": { "const": "wait" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "selector": { "type": "string" },
          "urlPattern": { "type": "string" },
          "durationMs": { "type": "integer", "minimum": 1, "maximum": 60000 },
          "snapshotLimit": { "type": "integer", "minimum": 0, "maximum": 200 }
        }
      },
      "screenshot": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "screenshot" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "mode": { "enum": ["viewport", "element", "full"], "default": "viewport" },
          "ref": { "type": "integer", "minimum": 1 },
          "snapshotId": { "type": "string" },
          "selector": { "type": "string" },
          "includeImage": { "type": "boolean", "default": true },
          "outputPath": { "type": "string" }
        }
      },
      "session": {
        "type": "object",
        "required": ["action", "op"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "session" },
          "op": { "enum": ["status", "connect", "disconnect"] },
          "browserName": { "enum": ["Chrome", "Chrome Beta", "Chrome Canary", "Brave", "Edge", "Chromium"] },
          "mode": { "enum": ["attach_user_browser", "isolated_profile"], "default": "attach_user_browser" }
        }
      },
      "eval": {
        "type": "object",
        "required": ["action", "code"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "eval" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "code": { "type": "string", "maxLength": 50000 },
          "expectMutation": { "type": "boolean", "default": false },
          "screenshot": { "type": "boolean", "default": false }
        }
      },
      "network": {
        "type": "object",
        "required": ["action", "op"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "network" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "op": { "enum": ["list", "show", "block", "mock", "headers", "remove", "clear"] },
          "id": { "type": "string" },
          "pattern": { "type": "string" },
          "method": { "type": "string" },
          "status": { "type": "integer" },
          "resourceType": { "type": "string" },
          "body": { "type": "string" },
          "filePath": { "type": "string" },
          "headers": {
            "type": "object",
            "additionalProperties": { "type": "string" }
          },
          "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
        }
      },
      "console": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "console" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "level": { "enum": ["all", "debug", "info", "log", "warn", "error"] },
          "filter": { "type": "string" },
          "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
        }
      },
      "download": {
        "type": "object",
        "required": ["action", "op"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "download" },
          "op": { "enum": ["save", "list", "pause", "resume", "cancel"] },
          "url": { "type": "string" },
          "id": { "type": "string" },
          "outputPath": { "type": "string" }
        }
      },
      "pdf": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "pdf" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "outputPath": { "type": "string" },
          "landscape": { "type": "boolean", "default": false }
        }
      },
      "upload": {
        "type": "object",
        "required": ["action", "paths"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "upload" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "selector": { "type": "string" },
          "nth": { "type": "integer", "minimum": 1 },
          "paths": {
            "type": "array",
            "minItems": 1,
            "maxItems": 20,
            "items": { "type": "string" }
          }
        }
      },
      "auth": {
        "type": "object",
        "required": ["action", "op"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "auth" },
          "op": { "enum": ["set", "clear"] },
          "username": { "type": "string" },
          "password": { "type": "string" }
        }
      },
      "cookies": {
        "type": "object",
        "required": ["action", "op"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "cookies" },
          "op": { "enum": ["list", "clear"] },
          "domain": { "type": "string" },
          "includeValues": { "type": "boolean", "default": false }
        }
      },
      "frame": {
        "type": "object",
        "required": ["action", "op"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "frame" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "op": { "enum": ["list", "switch", "read"] },
          "index": { "type": "integer", "minimum": 0 },
          "maxChars": { "type": "integer", "minimum": 1, "maximum": 100000 }
        }
      },
      "environment": {
        "type": "object",
        "required": ["action", "op"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "environment" },
          "tabId": { "$ref": "#/$defs/tabId" },
          "op": { "enum": ["get", "set"] },
          "width": { "type": "integer", "minimum": 100, "maximum": 8000 },
          "height": { "type": "integer", "minimum": 100, "maximum": 8000 },
          "zoom": { "type": "number", "minimum": 0.25, "maximum": 5 },
          "userAgent": { "type": "string" }
        }
      }
    }
  }
}
```

```json
{
  "name": "computer",
  "description": "Operate macOS applications through the cheapest reliable layer: app scripting/defaults first, accessibility tree and app-scoped native events second, OCR/screenshot last. Start app UI tasks with action=state. Prefer AX refs or stablePath over coordinates. Global HID delivery is not a normal model-facing path and must be denied or separately approved.",
  "input_schema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "oneOf": [
      { "$ref": "#/$defs/state" },
      { "$ref": "#/$defs/snapshot" },
      { "$ref": "#/$defs/find" },
      { "$ref": "#/$defs/click" },
      { "$ref": "#/$defs/type" },
      { "$ref": "#/$defs/key" },
      { "$ref": "#/$defs/set_value" },
      { "$ref": "#/$defs/perform" },
      { "$ref": "#/$defs/wait" },
      { "$ref": "#/$defs/screenshot" },
      { "$ref": "#/$defs/apps" },
      { "$ref": "#/$defs/menu" },
      { "$ref": "#/$defs/sdef" },
      { "$ref": "#/$defs/tell" },
      { "$ref": "#/$defs/defaults" },
      { "$ref": "#/$defs/ocr" },
      { "$ref": "#/$defs/nearest" },
      { "$ref": "#/$defs/observe_region" },
      { "$ref": "#/$defs/window" },
      { "$ref": "#/$defs/launch" },
      { "$ref": "#/$defs/why" }
    ],
    "$defs": {
      "rect": {
        "type": "object",
        "required": ["x", "y", "width", "height"],
        "additionalProperties": false,
        "properties": {
          "x": { "type": "number" },
          "y": { "type": "number" },
          "width": { "type": "number" },
          "height": { "type": "number" }
        }
      },
      "xy": {
        "type": "object",
        "required": ["x", "y"],
        "additionalProperties": false,
        "properties": {
          "x": { "type": "number" },
          "y": { "type": "number" }
        }
      },
      "modifiers": {
        "type": "array",
        "items": { "enum": ["shift", "cmd", "alt", "ctrl"] },
        "uniqueItems": true
      },
      "snapshotLimit": {
        "type": "integer",
        "minimum": 0,
        "maximum": 200,
        "default": 50
      },
      "state": {
        "type": "object",
        "required": ["action", "app"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "state" },
          "app": { "type": "string" },
          "snapshotLimit": { "$ref": "#/$defs/snapshotLimit" },
          "includeScreenshot": { "type": "boolean", "default": true },
          "screenshotPath": { "type": "string" }
        }
      },
      "snapshot": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "snapshot" },
          "app": { "type": "string", "description": "Omit only for frontmost observation." },
          "limit": { "$ref": "#/$defs/snapshotLimit" },
          "diff": { "type": "boolean", "default": false },
          "annotated": { "type": "boolean", "default": false },
          "withScreenshot": { "type": "boolean", "default": false },
          "outputPath": { "type": "string" }
        }
      },
      "find": {
        "type": "object",
        "required": ["action", "app"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "find" },
          "app": { "type": "string" },
          "role": { "type": "string" },
          "titleContains": { "type": "string" },
          "titleEquals": { "type": "string" },
          "valueContains": { "type": "string" },
          "first": { "type": "boolean", "default": false },
          "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 20 }
        }
      },
      "click": {
        "type": "object",
        "required": ["action", "app"],
        "additionalProperties": false,
        "oneOf": [
          { "required": ["ref"] },
          { "required": ["stablePath"] },
          { "required": ["text"] },
          { "required": ["xy"] }
        ],
        "properties": {
          "action": { "const": "click" },
          "app": { "type": "string" },
          "ref": { "type": "integer", "minimum": 1 },
          "snapshotId": { "type": "string" },
          "stablePath": { "type": "string", "description": "computer-pilot axPath equivalent." },
          "text": { "type": "string", "description": "OCR text fallback." },
          "textIndex": { "type": "integer", "minimum": 0 },
          "region": { "$ref": "#/$defs/rect" },
          "xy": { "$ref": "#/$defs/xy" },
          "button": { "enum": ["left", "right"], "default": "left" },
          "clickCount": { "enum": [1, 2], "default": 1 },
          "modifiers": { "$ref": "#/$defs/modifiers" },
          "verify": { "type": "boolean", "default": true },
          "snapshotLimit": { "$ref": "#/$defs/snapshotLimit" }
        }
      },
      "type": {
        "type": "object",
        "required": ["action", "app", "text"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "type" },
          "app": { "type": "string" },
          "text": { "type": "string" },
          "paste": { "enum": ["auto", "force", "never"], "default": "auto" },
          "snapshotLimit": { "$ref": "#/$defs/snapshotLimit" }
        }
      },
      "key": {
        "type": "object",
        "required": ["action", "app", "combo"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "key" },
          "app": { "type": "string" },
          "combo": { "type": "string", "description": "cmd+c, enter, escape, etc." },
          "snapshotLimit": { "$ref": "#/$defs/snapshotLimit" }
        }
      },
      "set_value": {
        "type": "object",
        "required": ["action", "app", "value"],
        "additionalProperties": false,
        "oneOf": [
          { "required": ["ref"] },
          { "required": ["stablePath"] }
        ],
        "properties": {
          "action": { "const": "set_value" },
          "app": { "type": "string" },
          "ref": { "type": "integer", "minimum": 1 },
          "snapshotId": { "type": "string" },
          "stablePath": { "type": "string" },
          "value": { "type": "string" },
          "snapshotLimit": { "$ref": "#/$defs/snapshotLimit" }
        }
      },
      "perform": {
        "type": "object",
        "required": ["action", "app", "axAction"],
        "additionalProperties": false,
        "oneOf": [
          { "required": ["ref"] },
          { "required": ["stablePath"] }
        ],
        "properties": {
          "action": { "const": "perform" },
          "app": { "type": "string" },
          "ref": { "type": "integer", "minimum": 1 },
          "snapshotId": { "type": "string" },
          "stablePath": { "type": "string" },
          "axAction": { "type": "string", "description": "AXPress, AXShowMenu, AXIncrement, etc." },
          "snapshotLimit": { "$ref": "#/$defs/snapshotLimit" }
        }
      },
      "wait": {
        "type": "object",
        "required": ["action", "app"],
        "additionalProperties": false,
        "oneOf": [
          { "required": ["text"] },
          { "required": ["ref"] },
          { "required": ["gone"] },
          { "required": ["newWindow"] },
          { "required": ["modal"] },
          { "required": ["focusedChanged"] }
        ],
        "properties": {
          "action": { "const": "wait" },
          "app": { "type": "string" },
          "text": { "type": "string" },
          "ref": { "type": "integer", "minimum": 1 },
          "gone": { "type": "integer", "minimum": 1 },
          "newWindow": { "type": "boolean" },
          "modal": { "type": "boolean" },
          "focusedChanged": { "type": "boolean" },
          "timeoutMs": { "type": "integer", "minimum": 1, "maximum": 60000 },
          "snapshotLimit": { "$ref": "#/$defs/snapshotLimit" }
        }
      },
      "screenshot": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "screenshot" },
          "app": { "type": "string" },
          "region": { "$ref": "#/$defs/rect" },
          "outputPath": { "type": "string" },
          "includeImage": { "type": "boolean", "default": true }
        }
      },
      "apps": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "apps" },
          "includeScriptability": { "type": "boolean", "default": true }
        }
      },
      "menu": {
        "type": "object",
        "required": ["action", "app"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "menu" },
          "app": { "type": "string" }
        }
      },
      "sdef": {
        "type": "object",
        "required": ["action", "app"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "sdef" },
          "app": { "type": "string" }
        }
      },
      "tell": {
        "type": "object",
        "required": ["action", "app", "script"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "tell" },
          "app": { "type": "string" },
          "script": { "type": "string" },
          "language": { "enum": ["applescript", "jxa"], "default": "applescript" },
          "expectMutation": { "type": "boolean", "default": false }
        }
      },
      "defaults": {
        "type": "object",
        "required": ["action", "op", "domain"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "defaults" },
          "op": { "enum": ["read", "write", "delete"] },
          "domain": { "type": "string" },
          "key": { "type": "string" },
          "value": {}
        }
      },
      "ocr": {
        "type": "object",
        "required": ["action"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "ocr" },
          "app": { "type": "string" },
          "region": { "$ref": "#/$defs/rect" },
          "minConfidence": { "type": "number", "minimum": 0, "maximum": 1 }
        }
      },
      "nearest": {
        "type": "object",
        "required": ["action", "app", "xy"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "nearest" },
          "app": { "type": "string" },
          "xy": { "$ref": "#/$defs/xy" },
          "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 5 }
        }
      },
      "observe_region": {
        "type": "object",
        "required": ["action", "app", "region"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "observe_region" },
          "app": { "type": "string" },
          "region": { "$ref": "#/$defs/rect" },
          "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 }
        }
      },
      "window": {
        "type": "object",
        "required": ["action", "app", "op"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "window" },
          "app": { "type": "string" },
          "op": { "enum": ["list", "focus", "move", "resize", "minimize", "close"] },
          "index": { "type": "integer", "minimum": 0 },
          "frame": { "$ref": "#/$defs/rect" }
        }
      },
      "launch": {
        "type": "object",
        "required": ["action", "app"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "launch" },
          "app": { "type": "string" },
          "waitForReady": { "type": "boolean", "default": true },
          "snapshotLimit": { "$ref": "#/$defs/snapshotLimit" }
        }
      },
      "why": {
        "type": "object",
        "required": ["action", "app"],
        "additionalProperties": false,
        "properties": {
          "action": { "const": "why" },
          "app": { "type": "string" },
          "ref": { "type": "integer", "minimum": 1 },
          "snapshotId": { "type": "string" },
          "stablePath": { "type": "string" },
          "lastError": { "type": "string" }
        }
      }
    }
  }
}
```

### Browser Tool

Model-facing name: `browser`.

Core actions:

| Action | Reference | Purpose |
| --- | --- | --- |
| `state` | `lin-agent BrowserAction state` | Return browser connection/workspace metadata without page content. |
| `navigate` | `bp open`, `lin-agent navigate`, `sider navigate` | Open URL, back, forward, reload, stop. Returns snapshot when useful. |
| `tab` | `bp tabs/tab/close`, `sider tab` | Create/list/switch/close agent-owned browser tabs. |
| `metadata` | `sider get_metadata` | Lightweight title/URL/author/date inspection. |
| `read` | `bp read`, `lin-agent read`, `sider get_text` | Read cleaned page content. |
| `find` | `lin-agent find`, `sider find` | Search current page text and return snippets. |
| `selection` | `sider get_selection` | Read the user's selected text when the task is about the active tab. |
| `snapshot` | `bp snapshot`, `lin-agent snapshot` | Return interactive page elements and ephemeral refs. |
| `click` | `bp click`, `lin-agent click`, `sider click` | Click a ref, selector, or viewport coordinate. Returns snapshot. |
| `type` | `bp type`, `lin-agent type`, `sider type` | Type into a ref or selector. Returns snapshot. |
| `press` | `bp press`, `lin-agent press`, `sider key` | Send a key or key combo. Returns snapshot. |
| `keyboard` | `bp keyboard`, `sider native input bridge` | Send trusted key events to focused/canvas editor paths. |
| `scroll` | `lin-agent scroll`, `sider scroll` | Scroll page/container or bring a target into view. |
| `wait` | `lin-agent wait`, `sider wait` | Wait for selector, URL pattern, or short duration. |
| `screenshot` | `bp screenshot`, `lin-agent screenshot`, `sider screenshot` | Capture viewport, full page, or selector. |

Advanced actions:

| Action | Gate |
| --- | --- |
| `session` | User-facing connect/disconnect/status if explicit session control is needed. Core actions may auto-resume/connect after approval. |
| `eval` | High-risk; ask-gated or domain-preapproved. |
| `network` | High-risk for interception/body access; ask-gated by rule/action. |
| `console` | Debug read; enabled for development/debug tasks. |
| `download` | File side effect; ask-gated when saving outside approved locations. |
| `pdf` | File side effect; ask-gated when writing a file. |
| `upload` | Path-sensitive local file side effect; ask-gated. |
| `auth` | Credential handling; ask-gated. |
| `cookies` | Credential/session data; ask-gated. |
| `frame` | Optional advanced targeting for iframe-heavy tasks. |
| `environment` | Viewport/zoom/user-agent changes; ask-gated when persistent or surprising. |

Browser action schemas:

```ts
type BrowserToolParams =
  | BrowserStateAction
  | BrowserNavigateAction
  | BrowserTabAction
  | BrowserMetadataAction
  | BrowserReadAction
  | BrowserFindAction
  | BrowserSelectionAction
  | BrowserSnapshotAction
  | BrowserClickAction
  | BrowserTypeAction
  | BrowserPressAction
  | BrowserKeyboardAction
  | BrowserScrollAction
  | BrowserWaitAction
  | BrowserScreenshotAction
  | BrowserSessionAction
  | BrowserEvalAction
  | BrowserNetworkAction
  | BrowserConsoleAction
  | BrowserDownloadAction
  | BrowserPdfAction
  | BrowserUploadAction
  | BrowserAuthAction
  | BrowserCookiesAction
  | BrowserFrameAction
  | BrowserEnvironmentAction;

type BrowserTabTarget = {
  tabId?: string; // omitted means the current agent-owned browser tab
};

type BrowserRefTarget = {
  ref: number;
  snapshotId?: string;
  selector?: never;
  xy?: never;
};

type BrowserSelectorTarget = {
  selector: string;
  ref?: never;
  snapshotId?: never;
  xy?: never;
};

type BrowserCoordinateTarget = {
  xy: { x: number; y: number };
  ref?: never;
  snapshotId?: never;
  selector?: never;
};

type BrowserElementTarget = BrowserRefTarget | BrowserSelectorTarget;
type BrowserAnyTarget = BrowserElementTarget | BrowserCoordinateTarget;

interface BrowserStateAction {
  action: "state";
  include?: Array<"tabs" | "active" | "workspaces" | "blockers" | "debug">;
}

type BrowserNavigateAction =
  | {
      action: "navigate";
      op?: "open"; // default when url is present; maps to bp open
      url: string;
      target?: "current" | "new"; // default current agent tab
      workspace?: string; // agent-owned tab group/workspace
      tabId?: string;
      waitUntil?: "interactive" | "complete";
      snapshotLimit?: number; // default 50
    }
  | {
      action: "navigate";
      op: "back" | "forward" | "reload" | "hard_reload" | "stop";
      tabId?: string;
      waitUntil?: "interactive" | "complete";
      snapshotLimit?: number;
    };

type BrowserTabAction =
  | { action: "tab"; op: "list"; workspace?: string }
  | {
      action: "tab";
      op: "create";
      url?: string;
      workspace: string;
      active?: boolean;
      snapshotLimit?: number;
    }
  | {
      action: "tab";
      op: "switch" | "close";
      tabId: string;
      snapshotLimit?: number;
    };

interface BrowserMetadataAction extends BrowserTabTarget {
  action: "metadata";
}

interface BrowserReadAction extends BrowserTabTarget {
  action: "read";
  selector?: string;
  offset?: number;
  maxChars?: number; // default bounded by runtime
}

interface BrowserFindAction extends BrowserTabTarget {
  action: "find";
  query: string;
  context?: number;
  limit?: number;
  matchOffset?: number;
}

interface BrowserSelectionAction extends BrowserTabTarget {
  action: "selection";
}

interface BrowserSnapshotAction extends BrowserTabTarget {
  action: "snapshot";
  filter?: "interactive" | "all";
  limit?: number; // default 50
}

type BrowserClickAction = {
  action: "click";
  button?: "left" | "right" | "middle"; // default left
  clickCount?: 1 | 2; // default 1
  snapshotLimit?: number; // default 50
} & BrowserAnyTarget & BrowserTabTarget;

type BrowserTypeAction = {
  action: "type";
  text: string;
  clear?: boolean;
  snapshotLimit?: number;
} & BrowserElementTarget & BrowserTabTarget;

interface BrowserPressAction extends BrowserTabTarget {
  action: "press";
  key: string; // Enter, Escape, Control+a, Meta+c, etc.
  ref?: number; // optional target to focus first
  snapshotId?: string;
  selector?: string;
  snapshotLimit?: number;
}

interface BrowserKeyboardAction extends BrowserTabTarget {
  action: "keyboard";
  text: string;
  clickSelector?: string;
  clear?: boolean;
  delayMs?: number;
  snapshotLimit?: number;
}

interface BrowserScrollAction extends BrowserTabTarget {
  action: "scroll";
  ref?: number;
  snapshotId?: string;
  selector?: string;
  direction?: "up" | "down" | "left" | "right" | "top" | "bottom";
  amount?: number;
  snapshotLimit?: number;
}

interface BrowserWaitAction extends BrowserTabTarget {
  action: "wait";
  selector?: string;
  urlPattern?: string;
  durationMs?: number;
  snapshotLimit?: number;
}

interface BrowserScreenshotAction extends BrowserTabTarget {
  action: "screenshot";
  mode?: "viewport" | "element" | "full";
  ref?: number;
  snapshotId?: string;
  selector?: string;
  includeImage?: boolean; // default true when within model image budget
  outputPath?: string;
}
```

Rules:

- `browser` validates `action` first, then validates only that action's fields.
- `click` requires exactly one of `ref`, `selector`, or `xy`.
- `type` requires exactly one of `ref` or `selector`.
- `type` and `keyboard` do not have a `submit` boolean. To submit, compose a
  following `press` action with `key: "Enter"`.
- `navigate target="new"` and `tab op="create"` should attach a `workspace`
  slug whenever the work is agent-initiated rather than explicitly targeting the
  user's current tab.
- Actions that mutate page/session state return `BrowserActionData` with
  `method` and, except for purely session operations, a fresh `snapshot` or a
  clear `snapshotError`/`instructions`.
- Advanced actions may be present in the TypeScript union but hidden by
  capability policy until enabled; hidden means the runtime rejects the action
  with `status: "denied"` and guidance, not that the schema becomes loose.

### Computer Tool

Model-facing name: `computer`.

Core actions:

| Action | Reference | Purpose |
| --- | --- | --- |
| `state` | `cu state` | Canonical task start: app, windows, displays, snapshot, screenshot/error. |
| `snapshot` | `cu snapshot` | AX tree refresh, diff, annotated/with-screenshot variants. |
| `find` | `cu find` | Predicate query; cheaper and less brittle than snapshot + text search. |
| `click` | `cu click` | Click by ref, axPath, text/OCR, or coordinates. |
| `type` | `cu type` | Text input route with paste auto-detection. |
| `key` | `cu key` | Shortcut route with terminal/IDE safety policy. |
| `set_value` | `cu set-value` | AXValue setter; semantically different from typing. |
| `perform` | `cu perform` | Named AX action; semantically different from clicking. |
| `wait` | `cu wait` | Closed-loop polling after actions and launches. |
| `screenshot` | `cu screenshot` | Visual state capture, region capture, capture-protection reporting. |

Advanced actions:

| Action | Gate |
| --- | --- |
| `apps` | Discovery; safe, but not usually needed after `state`. |
| `menu` | Discovery for non-scriptable apps. |
| `sdef` | Discovery for scriptable apps. |
| `tell` | AppleScript read/write; ask-gated by app and write risk. |
| `defaults` | System preference read/write; write is ask-gated. |
| `ocr` | Fallback perception; expose with visual/sparse-AX tasks. |
| `nearest` | VLM coordinate to ref bridge. |
| `observe_region` | VLM region to candidate refs bridge. |
| `window` | Window management; focus/close are ask-gated. |
| `launch` | App launch; usually safe but should be explicit. |
| `why` | Diagnostics for failed refs/actions. |

Computer action schemas:

```ts
type ComputerToolParams =
  | ComputerStateAction
  | ComputerSnapshotAction
  | ComputerFindAction
  | ComputerClickAction
  | ComputerTypeAction
  | ComputerKeyAction
  | ComputerSetValueAction
  | ComputerPerformAction
  | ComputerWaitAction
  | ComputerScreenshotAction
  | ComputerAppsAction
  | ComputerMenuAction
  | ComputerSdefAction
  | ComputerTellAction
  | ComputerDefaultsAction
  | ComputerOcrAction
  | ComputerNearestAction
  | ComputerObserveRegionAction
  | ComputerWindowAction
  | ComputerLaunchAction
  | ComputerWhyAction;

interface ComputerStateAction {
  action: "state";
  app: string;
  snapshotLimit?: number; // default 50
  includeScreenshot?: boolean; // default true
  screenshotPath?: string;
}

interface ComputerSnapshotAction {
  action: "snapshot";
  app?: string; // omitted means frontmost only for observation
  limit?: number;
  diff?: boolean;
  annotated?: boolean;
  withScreenshot?: boolean;
  outputPath?: string;
}

interface ComputerFindAction {
  action: "find";
  app: string;
  role?: string;
  titleContains?: string;
  titleEquals?: string;
  valueContains?: string;
  first?: boolean;
  limit?: number;
}

interface ComputerClickAction {
  action: "click";
  app: string; // required in v1; global actions are not model-facing by default
  ref?: number;
  snapshotId?: string;
  stablePath?: string; // axPath
  text?: string; // OCR text fallback
  textIndex?: number;
  region?: { x: number; y: number; width: number; height: number };
  xy?: { x: number; y: number };
  button?: "left" | "right";
  clickCount?: 1 | 2;
  modifiers?: Array<"shift" | "cmd" | "alt" | "ctrl">;
  verify?: boolean; // default true
  snapshotLimit?: number;
}

interface ComputerTypeAction {
  action: "type";
  app: string;
  text: string;
  paste?: "auto" | "force" | "never"; // default auto
  snapshotLimit?: number;
}

interface ComputerKeyAction {
  action: "key";
  app: string;
  combo: string; // cmd+c, enter, escape, etc.
  snapshotLimit?: number;
}

interface ComputerSetValueAction {
  action: "set_value";
  app: string;
  ref?: number;
  snapshotId?: string;
  stablePath?: string;
  value: string;
  snapshotLimit?: number;
}

interface ComputerPerformAction {
  action: "perform";
  app: string;
  ref?: number;
  snapshotId?: string;
  stablePath?: string;
  axAction: string; // AXPress, AXShowMenu, AXIncrement, ...
  snapshotLimit?: number;
}

interface ComputerWaitAction {
  action: "wait";
  app: string;
  text?: string;
  ref?: number;
  gone?: number;
  newWindow?: boolean;
  modal?: boolean;
  focusedChanged?: boolean;
  timeoutMs?: number;
  snapshotLimit?: number;
}
```

Rules:

- `app` is required for Computer state-changing actions in v1. A model-facing
  `allowGlobal` parameter should not exist initially. If global HID is ever
  needed, it should be a separate high-risk action enabled by permission policy
  or a runtime-mediated override, not a casual boolean.
- `click` accepts only one target mode per call: `ref`, `stablePath`, `text`, or
  `xy`. Validation must reject ambiguous calls.
- `set_value` and `perform` require exactly one of `ref` or `stablePath`.
- `wait` requires exactly one wait condition.
- Advanced discovery actions may be disabled until the Computer skill is active
  or the user request clearly asks for desktop control.

## Ref and Identity Rules

Rules shared by browser and computer tools:

- Numeric refs are short-lived. They are valid for the latest snapshot of the
  target and may change after every action.
- Every action that accepts a ref should also accept the last `snapshotId`.
  If the id is stale, the action may still run, but the response must include
  `staleStateAdvice`.
- The model-visible snapshot should omit implementation identifiers such as
  `backendDOMNodeId`, raw AX pointers, CDP session ids, or native window ids
  unless the model must use them.
- Stable selectors are domain-specific:
  - Browser: CSS selector, frame index/context, URL.
  - Computer: `axPath`, app name, window index, AppleScript object path.
- When both a structured selector and coordinates are available, prefer the
  structured selector.

## Browser Tool Contract

The `browser` tool is only available after the user enables browser control for
the session. Its default target is agent-owned browser tabs in the user's
approved browser profile, not arbitrary user tabs. If Lin later supports acting
on the user's currently active tab, that target mode must be explicit in the
request and permission copy.

### Browser Session Model

```ts
interface BrowserSessionState {
  mode: "attach_user_browser" | "isolated_profile";
  browserName: "Chrome" | "Chrome Beta" | "Chrome Canary" | "Brave" | "Edge" | "Chromium";
  connected: boolean;
  activeTargetId?: string;
  activeFrame?: number;
  activeUserTab?: BrowserTabSummary; // observation only unless explicitly targeted
  agentTabs: BrowserTabSummary[];
  workspaces: BrowserWorkspaceSummary[];
}

interface BrowserWorkspaceSummary {
  name: string;
  tabIds: string[];
  collapsed?: boolean;
}
```

`attach_user_browser` follows browser-pilot: connect to the user's existing
Chromium profile through CDP. It preserves logins and extensions, but it is
high risk because cookies, network bodies, and authenticated pages are exposed.

Agent-owned tabs should follow Sider's workspace principle: for multi-step
research or any page not explicitly identified as "this tab", create a
workspace tab and pass `tabId` to subsequent actions. The user should be able to
visually identify and close/collapse the agent's browser workspace.

`isolated_profile` is safer and should be supported later for tasks that do not
need the user's login state.

### Browser Action Registry

Initial capability-gated action registry:

| Action | Purpose | Reference command |
| --- | --- | --- |
| `session` | Connect, disconnect, or inspect browser session state. | `bp connect/disconnect` |
| `state` | Inspect connection, active tab, agent tabs, workspaces, blockers, debug state. | `lin-agent state` |
| `navigate` | Open URL in current/new agent tab, back, forward, reload, stop. | `bp open`, `lin-agent navigate`, `sider navigate` |
| `tab` | Create/list/switch/close agent tabs and workspaces. | `bp tabs/tab/close`, `sider tab` |
| `metadata` | Read title, URL, author, date, site metadata. | `sider get_metadata` |
| `read` | Read cleaned page content. | `bp read` |
| `find` | Search page text and return snippets. | `lin-agent find`, `sider find` |
| `selection` | Read highlighted text from an explicitly targeted user tab. | `sider get_selection` |
| `snapshot` | Return interactive page elements. | `bp snapshot` |
| `click` | Click a ref or viewport coordinate. Returns snapshot. | `bp click` |
| `type` | Type into a ref. Returns snapshot. | `bp type` |
| `press` | Send a key or key combo. Returns snapshot. | `bp press` |
| `keyboard` | Send keyboard text to focused/canvas editor target. | `bp keyboard` |
| `scroll` | Scroll or bring target into view. | `lin-agent scroll`, `sider scroll` |
| `wait` | Wait for selector, URL, or short duration. | `lin-agent wait`, `sider wait` |
| `eval` | Escape hatch for JS. High-risk and permission-gated. | `bp eval` |
| `screenshot` | Capture viewport, full page, or selector. | `bp screenshot` |
| `console` | Read recent page console messages. | `lin-agent console`, `sider read_console` |
| `frame` | List or switch iframe execution context. | `bp frame` |
| `network` | List/show/block/mock/header/remove/clear network rules. | `bp net` |
| `download` | Download through browser session or list/control downloads. | `lin-agent download` |
| `pdf` | Print/save the active page as PDF. | `bp pdf`, `lin-agent pdf` |
| `upload` | Upload a local file to an input. | `bp upload` |
| `auth` | Set/clear HTTP Basic Auth credentials. | `bp auth` |
| `cookies` | Read cookies, including HttpOnly cookies. | `bp cookies` |
| `environment` | Inspect/change viewport, zoom, or user agent. | `lin-agent environment` |

### Browser Operation Rules

- Do not overwrite the user's active tab for agent-initiated research. Create an
  agent-owned tab/workspace, then pass `tabId` to later actions.
- Prefer URL parameters over UI navigation when possible.
- Use `browser` action `read` for page content. Use `snapshot` only for
  interactive controls.
- Use `find` before full `read` when looking for a phrase in a long page.
- Use `eval` only for structured attributes, computed values, storage,
  or page manipulation not covered by narrower tools.
- Use `keyboard` for canvas/editor surfaces where DOM refs do not map
  to inputs.
- Do not use the `computer` tool to operate normal web pages.
- After `navigate`, `click`, `type`, `press`, `keyboard`, and `scroll`, return
  a fresh browser snapshot.
- Preserve a visible pilot-window indicator so the user can tell the agent is
  operating the browser.

### Browser Snapshot Data

```ts
interface BrowserSnapshot extends ControlSnapshot {
  targetKind: "browser_page";
  title: string;
  url: string;
  frame?: BrowserFrameSummary;
  elements: BrowserElement[];
}

interface BrowserElement extends ControlElement {
  role:
    | "button"
    | "link"
    | "textbox"
    | "searchbox"
    | "combobox"
    | "listbox"
    | "checkbox"
    | "radio"
    | "spinbutton"
    | "slider"
    | "switch"
    | "menuitem"
    | "tab";
  name: string;
}
```

Implementation details:

- Store `backendDOMNodeId` or equivalent in runtime state, scoped by
  `targetId` and `snapshotId`; do not expose it to the model.
- Include unnamed inputs if their role is input-like. The reference allows
  empty names for textbox/searchbox/combobox/listbox/checkbox/radio/spinbutton/
  slider/switch.
- Shadow DOM and contenteditable elements must appear when CDP exposes them in
  the accessibility tree.

### Browser Action Data

```ts
interface BrowserActionData extends ControlActionMeta {
  snapshot?: BrowserSnapshot;
}
```

Recommended `method` values:

| Method | Meaning |
| --- | --- |
| `cdp-navigate` | `Page.navigate` or target creation |
| `cdp-tab-create` | Agent-owned tab/workspace creation |
| `cdp-read` | Cleaned DOM/page text extraction |
| `cdp-find` | In-page text search/snippet extraction |
| `cdp-click-ref` | ref resolved to backend node, scrolled into view, clicked via CDP mouse events |
| `cdp-click-selector` | selector resolved in page, scrolled into view, clicked via CDP mouse events |
| `cdp-click-xy` | coordinate click via CDP mouse events |
| `dom-set-value` | input/textarea value setter plus `input`/`change` events |
| `cdp-insert-text` | contenteditable or text insertion through CDP |
| `cdp-keyboard` | key events to focused target |
| `cdp-eval` | JavaScript evaluation |
| `cdp-upload` | `DOM.setFileInputFiles` |

Coordinate methods should be `medium` confidence unless followed by a state
change that can be verified. `eval` confidence depends on the expression and
should not be treated as a page-action success unless the returned value proves
the intended result.

## Computer Tool Contract

The `computer` tool is macOS-only in the first implementation. It is only
available after the user enables desktop control and grants the required OS
permissions.

### Computer Action Registry

Initial capability-gated action registry:

| Action | Purpose | Reference command |
| --- | --- | --- |
| `state` | Canonical start call: snapshot + windows + screenshot/frontmost. | `cu state` |
| `apps` | List running apps and scriptability. | `cu apps` |
| `menu` | Enumerate app menu bar. | `cu menu` |
| `sdef` | Read scripting dictionary for scriptable app. | `cu sdef` |
| `tell` | Run AppleScript/JXA-style app script. | `cu tell` |
| `defaults` | Read/write macOS preferences. | `cu defaults` |
| `snapshot` | AX tree snapshot; optionally diff/annotated/screenshot. | `cu snapshot` |
| `find` | Predicate query over AX elements. | `cu find` |
| `nearest` | Coordinate to nearest ref. | `cu nearest` |
| `observe_region` | Candidate refs in a rectangle. | `cu observe-region` |
| `click` | Click by ref, axPath, text/OCR, or coordinates. | `cu click` |
| `type` | Type into focused element. | `cu type` |
| `key` | Send key combo. | `cu key` |
| `set_value` | Write AXValue directly. | `cu set-value` |
| `perform` | Invoke named AX action. | `cu perform` |
| `wait` | Poll for text/ref/window/modal/focus conditions. | `cu wait` |
| `screenshot` | Capture window/screen/region. | `cu screenshot` |
| `ocr` | On-device OCR text regions. | `cu ocr` |
| `window` | List/move/resize/focus/minimize/close windows. | `cu window` |
| `launch` | Launch app and wait for AX-ready window. | `cu launch` |
| `why` | Diagnose a failed or questionable ref/action. | `cu why` |

### Computer Operation Rules

- Start app tasks with `computer` action `state`, not separate apps/window/snapshot/
  screenshot calls.
- If an app is scriptable and the task is data-oriented, prefer
  actions `tell`/`sdef` over UI automation.
- Use action `defaults` for system preference reads/writes instead of driving
  System Settings UI.
- For non-scriptable app UI work, prefer AX refs and `stablePath` over
  coordinates.
- Every action should take `app` unless it is deliberately global. Global HID
  delivery should be denied or ask-gated by default.
- Read every advisory field ending in `Hint`, `Reason`, `Advice`, or `Error`.
- When `verified: false`, recover with a different structured primitive
  (`stablePath`, `perform`, `set_value`, `wait`) rather than falling back to
  global coordinates.
- OCR and screenshot are fallback perception layers, not the default action
  substrate.

### Computer Snapshot Data

```ts
interface ComputerSnapshot extends ControlSnapshot {
  targetKind: "desktop_app";
  app: string;
  pid?: number;
  window?: string;
  windowFrame?: Rect;
  focused?: {
    ref?: number;
    role: string;
    title?: string;
    value?: string;
  };
  modal?: {
    role: string;
    subrole?: string;
    title?: string;
  };
  displays?: DisplaySummary[];
  elements: ComputerElement[];
}

interface ComputerElement extends ControlElement {
  title?: string;
  stablePath?: string; // maps to computer-pilot axPath
}
```

The `computer` action `state` extends this with:

```ts
interface ComputerStateData {
  app: string;
  pid?: number;
  frontmost: boolean;
  windows: WindowSummary[];
  displays: DisplaySummary[];
  snapshot: ComputerSnapshot;
  screenshot?: string;
  imageScale?: number;
  screenshotError?: string;
}
```

### Computer Action Data

```ts
interface ComputerActionData extends ControlActionMeta {
  app?: string;
  ref?: number;
  stablePath?: string;
  x?: number;
  y?: number;
  snapshot?: ComputerSnapshot;
  verified?: boolean | null;
  verifyDiff?: { added: number; changed: number; removed: number };
  verifyAdvice?: string;
  staleStateAdvice?: string;
  pasteReason?: string;
  effectAdvice?: string;
}
```

Recommended `method` values should preserve the `computer-pilot` semantics:

| Method | Confidence | Meaning |
| --- | --- | --- |
| `ax-action` | high | Native AX action chain completed. |
| `ax-set-value` | high | AXValue setter completed. |
| `ax-perform` | high | Named AX action completed. |
| `cgevent-pid` | high | PID-targeted mouse event. |
| `unicode-pid` | high | PID-targeted Unicode keyboard event. |
| `paste-pid` | high | Clipboard paste route to target process; include `pasteReason`. |
| `key-pid` | high | PID-targeted key combo. |
| `ocr-text-pid` | medium | OCR-derived coordinates, delivered to target process. |
| `cgevent-global` | low | Global HID mouse event; disruptive. |
| `unicode-global` | low | Global HID text event; disruptive. |
| `paste-global` | low | Global paste; disruptive. |
| `key-global` | low | Global key combo; disruptive. |
| `ocr-text-global` | low | OCR-derived global click; disruptive. |

The result must include `advice` for `*-global` methods and any medium/low
confidence route.

## Permissions and Safety

These tools touch sensitive state. Permission policy must be implemented in the
runtime, not delegated to the model.

### Browser Permission Classes

| Action | Default behavior |
| --- | --- |
| Connect to user's real browser profile | ask |
| Open public URL in agent-owned browser tab | allow after browser session approval |
| Read page content from agent-owned browser tab | allow after browser session approval |
| Click/type/press in agent-owned browser tab | allow or ask depending on domain policy |
| Act on the user's current non-agent tab | ask, with tab title and URL shown |
| `browser` action `eval` | ask unless preapproved for the domain/task |
| Read cookies | ask |
| Show network response body | ask when authenticated or cross-origin sensitive |
| Block/mock/override network requests | ask |
| Upload local file | ask, with path shown |
| Set HTTP auth credentials | ask |

Domain-scoped session rules should be narrow: browser, origin, action class,
and optionally URL pattern. A saved broad rule such as "allow eval everywhere"
should not be offered in the primary approval path.

### Computer Permission Classes

| Action | Default behavior |
| --- | --- |
| Enable desktop control / request OS permissions | ask |
| Observe app snapshot/state | allow after desktop session approval, except sensitive apps |
| Screenshot / OCR | ask for sensitive apps or full-screen capture |
| Scriptable read (`computer` action `tell` data read) | ask on first app/domain |
| Scriptable write / `defaults write` | ask |
| AX click/set-value/perform with app target | allow or ask depending on app policy |
| PID-targeted type/key | allow or ask depending on app policy |
| Global HID action | deny by default; ask only with explicit user intent |
| Window focus/move/close | ask for focus/close, allow or ask for move/resize depending on app |

Sensitive app categories include terminals, IDEs, password managers, banking
apps, messaging apps, and any app that refuses screenshot capture. Capture
protection must be reported as `screenshotError`; Lin must not attempt to
bypass OS-level capture refusal.

## Implementation Boundary

Lin's product implementation stays in TypeScript/Electron:

- Browser provider: TypeScript CDP client and session manager in Electron main.
  The `browser-pilot` CLI/daemon can be used as a research reference, not
  copied as a product dependency.
- Computer provider: TypeScript-owned adapter interface first. Native macOS AX,
  CoreGraphics, ScreenCaptureKit, and Vision bindings can be introduced only if
  they fit the TypeScript/Electron boundary. A user-installed `cu` CLI adapter
  may be useful as an optional prototype connector, but it must not become a
  Rust runtime subtree inside this repo.
- Renderer: approval UI, transcript rendering, and capability toggles only.
  Renderer must not hold browser CDP credentials, OS permissions, raw cookies,
  or tool execution state.
- Main process: session lifecycle, permission enforcement, tool gateway,
  provider adapters, audit logging, and result slimming.

Provider interface sketch:

```ts
interface BrowserControlProvider {
  execute(params: BrowserToolParams, signal?: AbortSignal): Promise<ToolEnvelope<unknown>>;
}

interface ComputerControlProvider {
  execute(params: ComputerToolParams, signal?: AbortSignal): Promise<ToolEnvelope<unknown>>;
}
```

## Prompt and Skill Strategy

The pilots both rely on detailed skill guidance. Lin should not dump every
Browser/Computer rule into the base system prompt. Sider's `web` skill adds a
second important pattern: site-specific browser code should live in skills and
auto-injected libraries, not in the base prompt or as separate model-facing
tools.

Use progressive disclosure:

- Default hidden tool listing only names the capability and how to enable it.
- When enabled, inject a compact domain guide:
  - Browser: agent tab/workspace > metadata/find/read > snapshot/click/type >
    press/keyboard > eval.
  - Computer: state > script/defaults if possible > AX refs/stablePath >
    OCR/screenshot fallback.
- Put exhaustive command detail in skill/reference files loaded only when the
  capability is active or the model asks for help.
- Preserve anti-patterns explicitly. The computer guide should say not to use
  global HID fallback for `verified:false`; the browser guide should say not to
  use `eval` for ordinary text extraction.

Recommended bundled skills:

- `browser`: operational guide for the `browser` tool, including tab ownership,
  `read` vs `snapshot`, ref staleness, iframe/network/upload/cookie risk, and
  recovery from stale refs or missing screenshots.
- `web`: generic website automation methodology plus optional per-site
  libraries. Matching URL patterns can auto-inject library code into
  `browser` action `eval`/`keyboard` contexts, following Sider's
  `libraries.json` pattern.
- `computer`: operational guide for the `computer` tool, including the tier
  order (script/defaults -> AX/native -> OCR/screenshot), `method` meanings,
  verification advice, stale refs, capture-protected windows, and global HID
  warnings.

The skills should teach composition rather than introduce more tool names. For
example, browser form submission is `type` followed by `press Enter`, not a
separate submit tool or a `submit` boolean. Google Sheets or WhatsApp-specific
flows belong in a `web` library that uses native input bridges where needed.

## Rollout Plan

### Phase 1: Contract and UI plumbing

- Add capability flags for Browser and Computer.
- Add permission categories and approval copy for browser profile access,
  browser eval/cookies/network/upload, desktop observation, desktop action, and
  global HID action.
- Add shared control result types in TypeScript.
- Add event-log/audit rendering for control tool calls and advisory strings.

### Phase 2: Browser provider

- Implement CDP connection to a user-approved Chromium browser.
- Create/resume agent-owned pilot window/tabs.
- Implement `browser` actions `state`, `navigate`, `tab`, `metadata`, `read`,
  `find`, `snapshot`, `click`, `type`, `press`, `scroll`, `wait`, and
  `screenshot`.
- Add `browser` action `eval` behind approval.
- Add network monitor/interception after the core loop is stable.

Acceptance:

- Uses the user's real browser profile when `attach_user_browser` is selected.
- Operates only pilot targets by default.
- Every action returns method + fresh snapshot.
- Ref actions are scoped by target and snapshot.
- `read` works for article/search/list pages without `eval`.
- Agent-initiated browsing creates agent-owned tabs/workspaces instead of
  clobbering the user's current tab.

### Phase 3: Computer provider MVP

- Implement `computer` actions `apps`, `state`, `snapshot`, `click`, `type`,
  `key`, `wait`, and `screenshot` for macOS.
- Implement `computer` actions `tell` and `sdef` for scriptable apps.
- Add method/confidence/advice fields from the beginning.
- Deny global HID by default.

Acceptance:

- `computer` action `state` is the recommended task start and returns a single coherent
  view.
- Ref click prefers AX actions before coordinate/native events.
- PID-targeted or app-scoped delivery is distinguishable from global delivery.
- Capture-protected windows produce `screenshotError`, not blank images.

### Phase 4: Reliability parity

- Add post-action snapshot settle waiting.
- Add stale ref detection with `staleStateAdvice`.
- Add click verification with `verified`, `verifyDiff`, and `verifyAdvice`.
- Add `computer` actions `set_value`, `perform`, `find`, `nearest`,
  `observe_region`, OCR confidence hints, and annotated screenshots.

## Open Questions

- Should `attach_user_browser` be available in trusted mode by default, or only
  after a separate browser-control onboarding gate?
- Should Computer MVP depend on a user-installed `cu` adapter first, or wait for
  TypeScript-native macOS bindings? The contract should be stable either way.
- What is the minimum safe approval UX for authenticated browser network bodies
  and cookies?
- How should Lin identify "sensitive apps" beyond hardcoded app names?

## Checks Before Implementation

- Every mutating `browser`/`computer` action returns a fresh state or an explicit
  reason why no state is attached.
- Every action has a `method`.
- Every medium/low confidence or degraded path has a named string field and
  `instructions`.
- Numeric refs are scoped by target and snapshot.
- The `browser` tool never acts on arbitrary user tabs by default; agent work
  uses agent-owned tabs/workspaces unless the user explicitly targets the
  current tab.
- The `computer` tool denies or asks before any global HID action.
- Tool results fit Lin's `ToolEnvelope` and tool-output slimming path.
