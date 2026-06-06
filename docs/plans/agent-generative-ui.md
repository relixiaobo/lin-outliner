---
status: draft
priority: P3
owner: relixiaobo
created: 2026-06-03
updated: 2026-06-03
---

# Agent Generative UI

## Goal

Add Claude-style custom visuals in Lin's agent chat: the assistant can generate
interactive HTML/SVG widgets that appear inline in the conversation while the
tool arguments stream.

The target behavior is:

```txt
user asks for a visual or interactive explanation
  -> agent calls visualize_read_me({ modules })
  -> agent calls show_widget({ title, widget_code, width?, height? })
  -> runtime reads partial tool arguments during toolcall_delta
  -> renderer mounts an isolated widget iframe
  -> iframe progressively patches the HTML/SVG preview
  -> final tool call completion runs scripts once
```

This is a chat-native, ephemeral visualization surface. It is not a persistent
Artifact/Canvas editor and is not an outliner node type in this delivery.

## Non-goals

- Do not implement a long-lived artifact editor, file-backed web app workspace,
  or visual canvas in this plan.
- (Scope clarification) Making widget interaction state agent-perceivable and
  persistent IS in scope, but only as a small declared structured value reported
  by the widget — it must not grow into a DOM-snapshot rehydrator or a general
  stateful-app runtime.
- Do not parse magic Markdown/code-fence blocks as the primary protocol. Lin
  already has pi-ai tool-call streaming; use it.
- Do not inject model-generated HTML into the React DOM.
- Do not relax Electron's main renderer security posture broadly. Any frame
  allowance must be scoped to the widget renderer.
- Do not give widget code access to Node, preload APIs, the host DOM, document
  state, local files, or agent tool execution.
- Do not copy Anthropic's extracted design guidelines verbatim. Write Lin's own
  visual guidance and use references only to understand behavior and constraints.
- Do not require every provider to support fine-grained tool-call streaming.
  Providers that emit a single full argument delta should still render correctly.

## Current State

Lin already has the right execution foundation:

- `@earendil-works/pi-ai` exposes `toolcall_delta` events whose
  `partial.content[contentIndex].arguments` contain best-effort parsed partial
  JSON.
- `@earendil-works/pi-agent-core` forwards assistant `message_update` events
  with the underlying `assistantMessageEvent`.
- `src/main/agentRuntime.ts` already subscribes to pi-agent-core events and
  emits coalesced render projections.
- `src/core/agentEventLog.ts` already defines tool-call event types, including
  `tool_call.delta`.
- `src/core/agentRenderProjection.ts` already separates durable event replay
  from renderer projections.
- `src/renderer/ui/agent/AgentMessageRow.tsx` and
  `src/renderer/ui/agent/AgentToolCallBlock.tsx` already render assistant
  tool-call blocks.

Important gaps:

- `AgentRuntime.handlePiAgentEvent()` currently handles assistant text deltas
  only. Tool calls are appended when the assistant message ends or tool execution
  starts, so the UI does not see a `show_widget` call while its arguments are
  still streaming.
- `tool_call.delta` is a declared event type, but replay/projection does not
  apply tool-call deltas into visible render state.
- `AgentRenderProjection` has no transient per-tool-call widget state.
- The main renderer CSP currently has `frame-src 'none'`, so inline widget
  iframes need a deliberately scoped CSP change.
- There is no iframe shell, progressive DOM patching, script finalization, or
  host bridge for generated widgets.

## Verified Findings (2026-06-03)

The riskiest unknown — the inline iframe substrate — was tested directly, first
in Chromium under Lin's exact renderer CSP (HTTP-header `script-src 'self'`),
then in a real Electron window with `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`. Question: does a widget's inline `<script>` run?

| Substrate | Frame loads? | Inline `<script>` runs? |
|---|---|---|
| `srcdoc` + sandbox | yes | NO |
| `srcdoc`, no sandbox | yes | NO |
| `blob:` + sandbox | yes (needs `frame-src blob:`) | NO |
| custom-protocol response + sandbox | yes (needs `frame-src <scheme>:`) | YES; `postMessage` + height report work |

Root cause: `srcdoc` and `blob:` documents inherit the embedder's CSP, so the
renderer's `script-src 'self'` (no `'unsafe-inline'`) silently kills widget
inline scripts. A frame loaded from a real response with its own origin (an
Electron custom protocol via `protocol.handle`) does NOT inherit; it carries its
own CSP and runs scripts. This is a Chromium invariant, confirmed identically in
real Electron.

Decisions forced by this:

- The widget substrate is a **custom protocol** (e.g. `lin-widget://`, registered
  privileged with `{ standard: true, secure: true }`), NOT `srcdoc` or `blob:`.
  `srcdoc`/`blob:` are viable only for script-free static SVG/HTML and must not
  be the primary path.
- `frame-src` must be widened from `'none'` to allow that scheme only.
- The widget frame serves its OWN CSP. To run model-authored inline JS it needs
  `script-src 'unsafe-inline'` (or a per-widget nonce); this is safe because the
  frame is a sandboxed opaque origin with `default-src 'none'` (no network, no
  host DOM, no `allow-same-origin`). Any CDN allowlist lives in this frame's CSP,
  isolated from the host renderer.
- Dev/prod divergence trap: Lin injects CSP only on the packaged `file://`
  mainFrame; the Vite dev server is unrestricted. `srcdoc` widgets therefore
  "work" in dev and break only when packaged. The substrate MUST be validated in
  a packaged / CSP-enforced build, not just `dev:*`.

The widget-state channel (the perceivable/persistent capability) was likewise
verified in real Electron, same sandbox posture:

- Host → sandboxed widget `postMessage` is delivered (this underpins `set-content`
  AND `set-state`/rehydration), and a structured state object survives intact in
  both directions.
- Identification: a sandboxed widget's origin is opaque (`"null"`), so the host
  CANNOT identify which widget replied via `event.origin` — it must match by
  `event.source === iframe.contentWindow`. The widget DOES see the real host
  origin (`lin-widget://host`) and can verify the sender. Bridge routing therefore
  keys on `event.source`; any `toolCallId` in the message is a cross-check hint,
  not the trust anchor.
- The per-turn context-injection seam already exists: `agentRuntime` assembles
  ephemeral, non-persisted per-turn reminders (`buildEnvironmentContextReminder`,
  `buildOutlinerContextReminder`, and notably `userViewContextReminderTracker`,
  which already snapshots/diffs UI state per turn) before `agent.prompt()`
  (`agentRuntime.ts:629-659`). Widget-state injection reuses this mechanism — no
  new plumbing.

## Reference Review

Use these references to understand the implementation mechanics. Do not copy
private/proprietary text or unsafe host behavior.

### pi-ai and pi-agent-core

Primary source for Lin's actual streaming protocol.

Files to inspect in this repo:

- `node_modules/@earendil-works/pi-ai/README.md`
- `node_modules/@earendil-works/pi-agent-core/README.md`
- `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts`
- `node_modules/@earendil-works/pi-ai/dist/types.d.ts`

Relevant behavior:

- `toolcall_start` identifies the content block by `contentIndex`.
- `toolcall_delta` carries a JSON chunk and a partial assistant message.
- `partial.content[contentIndex].arguments` is best-effort parsed and may be
  incomplete.
- Provider streams may interleave text, thinking, and tool-call events; consumers
  must associate updates by `contentIndex`, not by event adjacency.
- Some providers may not stream function arguments token-by-token; they may emit
  one complete delta. Lin must treat that as a valid degraded path.

### Michaelliv/pi-generative-ui

Reference for a working pi-based clone of Claude-style generative UI.

Local research path:

- `/Users/lixiaobo/Documents/New project 2/oss-inline-visuals-research/pi-generative-ui`

Files to inspect:

- `.pi/extensions/generative-ui/index.ts`
- `.pi/extensions/generative-ui/guidelines.ts`
- `.pi/extensions/generative-ui/svg-styles.ts`
- `README.md`

Useful patterns:

- Registers `visualize_read_me` and `show_widget`.
- Listens to `message_update`.
- Tracks `toolcall_start`, `toolcall_delta`, and `toolcall_end`.
- Reads partial `widget_code` from parsed tool arguments.
- Opens a stable shell and injects updates through a bridge instead of replacing
  the full page.
- Debounces visual updates at about 150ms.
- Uses `morphdom` to patch the DOM.
- Executes `<script>` tags only after streaming completes.

Lin decisions:

- Copy the protocol shape and streaming mechanics, not the external native window
  container. Lin should render inline in the agent transcript.
- Do not copy the claimed verbatim Claude guidelines. Write Lin-owned guidance.
- Use React + iframe messaging instead of Glimpse/WKWebView.

### Claude Desktop static analysis

Reference for the product shape, not a source to copy.

Local research path:

- `/Users/lixiaobo/Documents/New project 2/oss-inline-visuals-research/claude-desktop/extracted`

Files to inspect:

- `.vite/build/index.js`
- `.vite/build/mainView.js`
- `.vite/build/coworkArtifact.js`

Observed behavior from prior static research:

- Claude Desktop contains an internal `visualize` server.
- The tool family includes `read_me` and `show_widget`.
- `show_widget` accepts `widget_code`.
- The UI resource is `ui://imagine/show-widget.html`.
- The resource MIME type is `text/html;profile=mcp-app`.
- Strings indicate progressive SVG/HTML rendering and script execution after
  streaming completes.
- The implementation has CSP and resource-domain controls.

Lin decisions:

- Match the high-level architecture: tool call plus isolated UI resource.
- Do not depend on Claude-specific names beyond `visualize_read_me` and
  `show_widget`. Pre-release clean-cut policy means Lin ships its target tool
  protocol, not a Claude-compatibility layer.
- Treat Claude's implementation as evidence that this feature should be
  isolated and resource-based, not direct host DOM injection.

Official public context:

- https://claude.com/blog/claude-builds-visuals
- https://support.claude.com/en/articles/13979539-custom-visuals-in-chat-and-cowork

### Alma

Reference for chat-inline iframe rendering with `morphdom`.

Local research path:

- `/Users/lixiaobo/Documents/New project 2/oss-inline-visuals-research/alma-app/extracted`

File to inspect:

- `out/renderer/assets/index-CpojPn66.js`

Useful patterns:

- `widgetRenderer` receives an `html` field as a tool-call parameter.
- A stable iframe shell receives `set-content` updates.
- `morphdom` updates the document without full reload flashes.
- Finalization sends `run-scripts`.
- The iframe is sandboxed with scripts, without same-origin host access.
- The host can expose narrow postMessage commands such as open-link or
  send-prompt.

Lin decisions:

- Use Alma as a renderer reference for inline chat behavior.
- Prefer `postMessage` between host React and the iframe shell.
- Keep host bridge capabilities narrow and auditable.

### CodePilot and Open WebUI inline visualizer

Secondary references for alternatives.

Local research paths:

- `/Users/lixiaobo/Documents/New project 2/oss-inline-visuals-research/CodePilot`
- `/Users/lixiaobo/Documents/New project 2/oss-inline-visuals-research/open-webui-plugins`

Useful patterns:

- CodePilot demonstrates a code-fence/JSON protocol for `show-widget`.
- Open WebUI demonstrates marker-block parsing and parent-DOM observation.

Lin decisions:

- Do not use either as the primary implementation because Lin already has real
  tool-call streaming.
- Do not build a fallback parser in the initial implementation; if a provider
  cannot use the tool-call protocol, fix the provider/tool seam rather than adding
  a second widget authority.

## Product Scenarios

Prioritize scenarios where a temporary interactive surface is more useful than
text, Markdown tables, or static images:

- Explain complex concepts with controls: compound interest, event loop, TCP,
  sorting algorithms, transformers, garbage collection, or math/physics demos.
- Visualize outliner content: outline structure, node graphs, tag distribution,
  field statistics, search result clusters, or project status dashboards.
- Support planning: timelines, dependency graphs, priority matrices, risk
  matrices, roadmap tradeoffs, and decision cards.
- Inspect agent work: tool execution timelines, trace waterfalls, module
  dependency maps, failure propagation, or verification checklists.
- Generate interactive decision helpers: calculators, option comparison cards,
  sliders, filters, and lightweight forms.
- Preview UI/mockups: settings panels, dashboards, forms, mobile screens, and
  small interaction states.

## Architecture

### Model-facing tools

Add two built-in tools.

#### `visualize_read_me`

Purpose:

- Give the model Lin-owned visual generation guidance.
- Encourage sparse, chat-native visual widgets.
- Load only relevant guidance modules.

Parameters:

```ts
{
  modules: Array<'diagram' | 'mockup' | 'interactive' | 'chart' | 'art' | 'outliner' | 'agent'>
}
```

Behavior:

- Return text guidance.
- Mark the current run/session as having loaded visual guidance for prompt/UI
  purposes if useful.
- No document mutation.
- No permission prompt.

Initial modules:

- `diagram`: SVG flowcharts, architecture diagrams, and structural diagrams.
- `interactive`: sliders, toggles, calculators, and explainers.
- `chart`: Chart.js or lightweight SVG charts.
- `mockup`: compact UI surfaces and cards.
- `outliner`: Lin-specific node/tag/field visualizations.
- `agent`: progress, tool trace, and runtime/debug visualizations.
- `art`: optional low-priority creative SVG/canvas output.

Guidance constraints:

- HTML fragments only; no `DOCTYPE`, `html`, `head`, or `body`.
- Put `<style>` first, content next, scripts last.
- Prefer inline SVG for diagrams and simple visuals.
- Scripts run only after streaming completes.
- No host DOM assumptions.
- No external resources except the widget CDN allowlist.
- Keep output bounded and focused.
- Use Lin CSS variables only if the widget shell defines them.

#### `show_widget`

Purpose:

- Render visual content inline in the agent transcript.

Parameters:

```ts
{
  i_have_seen_read_me?: boolean;
  title: string;
  widget_code: string;
  width?: number;
  min_height?: number;
  aspect?: 'auto' | 'wide' | 'square' | 'tall';
}
```

Behavior:

- The tool execution returns a short text result such as
  `Widget rendered and shown to the user.`
- The tool execution does not create files, mutate the document, or inject HTML.
- Rendering is driven by runtime/projection state from the tool-call arguments.
- If no streaming state was captured, renderer still displays the final
  `widget_code` from the completed tool call.

Permission:

- `show_widget` should be auto-allowed in normal modes because it only renders
  an isolated UI.
- If future bridge actions can send follow-up prompts or open URLs, those
  actions are host-mediated and separately controlled.

### Runtime streaming state

Add transient runtime state **per run, not on the session singleton**. The program's F5
splits the `AgentSessionState` bundle precisely so parallel runs don't clobber shared
transient state, so widget streaming state must hang off the executing `Run`
([[agent-program]] F5 / [[agent-data-model]]) — otherwise two concurrent runs emitting
widgets would overwrite each other. Shape:

```ts
interface StreamingVisualWidgetState {
  toolCallId: string;
  messageId: string;
  contentIndex: number;
  name: 'show_widget';
  title: string | null;
  widgetCode: string;
  width: number | null;
  minHeight: number | null;
  status: 'streaming' | 'complete' | 'error';
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}
```

Use a `Map<string, StreamingVisualWidgetState>` keyed by `toolCallId`.

Runtime rules:

- On `assistantMessageEvent.type === 'toolcall_start'`, inspect the partial
  content block. If it is `show_widget`, create a streaming widget state.
- On `toolcall_delta`, look up by `contentIndex`, read
  `partial.content[contentIndex].arguments`, and update title/size/widget_code
  defensively.
- On `toolcall_end`, finalize from `event.toolCall.arguments`.
- On `message_end`, ensure final tool calls still create renderable widget
  state even when the provider did not stream arguments.
- Clear transient widgets at run end only after final tool calls have been
  represented in durable assistant content.
- Coalesce projection updates using the existing `message_update` coalescing
  path.

Do not write every widget-code delta to `events.jsonl`. The durable record is
the final assistant tool call already stored in the assistant message. The live
delta stream is transient render state.

### Render projection

Extend `AgentRenderProjection` with visual widget entities:

```ts
interface AgentRenderVisualWidgetEntity {
  toolCallId: string;
  messageId: string;
  title: string;
  html: string;
  width: number;
  minHeight: number;
  status: 'streaming' | 'complete' | 'error';
  currentState: Record<string, unknown> | null;
  updatedAt: number;
}
```

Potential projection shape:

```ts
visualWidgets: Record<string, AgentRenderVisualWidgetEntity>
```

Projection sources (ONE unified entity, populated by whichever source is live):

- While streaming: the transient `streamingVisualWidgets` map supplies live `html`
  and `status: 'streaming'`.
- After completion / on replay / on restore: the completed assistant
  `toolCall.arguments.widget_code` supplies `html` and `status: 'complete'`.
- The latest `widget_state.updated` event supplies `currentState` for rehydration.

The renderer consumes only `{ html, status, currentState }` and does not know
which source produced it — one render path, not a static path plus a bolted-on
streaming overlay. Restored sessions display the final widget even though the live
deltas are gone.

### Renderer integration

Add:

- `src/renderer/ui/agent/AgentVisualWidget.tsx`
- `src/renderer/styles/agent-visual-widget.css`
- relevant tests under `tests/renderer/`

Rendering rules:

- In `AgentMessageRow`, when a tool call is `show_widget`, render
  `AgentVisualWidget` instead of the default `AgentToolCallBlock`.
- Keep the normal tool disclosure available for debug/expanded details if the
  PM wants it; the default visible surface should be the widget, not raw JSON.
- Show a compact loading state before enough `widget_code` exists.
- For failed or empty widget code, fall back to a normal tool block or an error
  panel.

Iframe rules:

- Use a stable iframe shell.
- Send updates by `postMessage`, not by rewriting `srcdoc` on every delta.
- The shell listens for:

```ts
{ type: 'set-content'; html: string; streaming: boolean }
{ type: 'finalize'; html: string }
```

- During streaming, patch DOM with `morphdom` or a local equivalent.
- On finalization, patch one last time and execute scripts once.
- Scripts are inert during streaming.
- External links are intercepted and delegated to host.
- Widget-to-host messages are accepted only for a small allowlist.

### Widget shell

Preferred initial implementation (see Verified Findings):

- Serve the widget document from a custom protocol (`lin-widget://`), registered
  privileged; `protocol.handle` returns the HTML with the widget's own CSP.
- Set iframe `sandbox="allow-scripts"`; do not include `allow-same-origin`.
- Do NOT use `srcdoc` or `blob:` for script-bearing widgets — both inherit the
  renderer CSP and block inline scripts (verified). Reserve them for static,
  script-free SVG/HTML only.

The shell should define:

- CSS reset and Lin-compatible theme variables.
- `window._setContent(html)`.
- `window._runScripts()`.
- Optional auto-height reporting via `ResizeObserver`.
- Optional `openLink(url)` bridge.
- No `sendPrompt(text)` bridge — out of scope for this delivery (see Non-goals).

Patch strategy:

- Bundle `morphdom` locally (the patcher is never remote). On each debounced
  `set-content` during streaming, `morphdom` patches the DOM — giving stable
  sliders, controls, and partial layouts instead of full reloads/flicker.

Script strategy:

- Strip/ignore script execution during `set-content`.
- On `finalize`, replace each script node with a new script element.
- Preserve script `src`.
- Execute inline scripts once.
- Do not support module (`type="module"`) scripts unless there is a clear need.

### Security model

Security requirements are release-blocking.

Host renderer:

- Keep `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Keep generated widget code out of React DOM.
- Do not expose `window.lin` to the iframe.
- Do not allow same-origin iframe access.

Iframe:

- `sandbox="allow-scripts"` only (no other sandbox capabilities).
- No `allow-same-origin`.
- No forms, popups, top navigation, downloads, pointer lock, or modals.
- Links are intercepted and sent to the host for explicit `openExternalUrl`.
- Host ignores any message that does not match the explicit widget bridge schema.

CSP:

- Current packaged renderer CSP uses `frame-src 'none'`.
- Change only as narrowly as needed.
- Resolved by Verified Findings: serve the widget from a custom `lin-widget://`
  protocol and widen `frame-src` to `<scheme>:` only. `srcdoc`/`blob:` inherit
  the renderer CSP and silently break widget scripts, so they are not options for
  the interactive path.
- The widget frame serves its own CSP: `default-src 'none'`, `script-src
  'unsafe-inline'` (plus approved CDNs only if ever enabled), `style-src
  'unsafe-inline'`. Inline scripts are required because the model authors inline
  JS; this is contained by the sandboxed opaque origin with no network or host
  access.

CDN allowlist:

- Bundle `morphdom` locally; the patcher is never remote.
- Prefer inline SVG and model-supplied inline data for most visuals.
- For heavier libraries the model legitimately needs (e.g. Chart.js), allow a
  small curated `script-src` allowlist (`https://cdn.jsdelivr.net`,
  `https://cdnjs.cloudflare.com`) in the WIDGET FRAME's own CSP only — never the
  host renderer's.
- `connect-src` and `img-src` stay `'none'`/`data:` even with that allowlist, so a
  CDN-loaded script has no exfiltration channel and no host access — the blast
  radius is the isolated frame, which already runs arbitrary inline JS.

### Host bridge

Core bridge:

- `resize`: widget reports content height.
- `open-link`: host validates `http:`/`https:` and uses existing external URL
  handling.
- `state`: widget reports its current structured state (see Widget state ↔
  agent). Persisted and injected into the agent's next turn.

Out of scope for this delivery (non-goals — separate features, not later versions):

- `send-prompt`: append a follow-up user message to the chat.
- `copy`: host-mediated clipboard write.

Bridge routing must key on `event.source === iframe.contentWindow` (a sandboxed
widget's origin is opaque `"null"`, so `event.origin` cannot identify it — verified
in Verified Findings); any `toolCallId` in the message is a cross-check hint, not
the trust anchor. Ignore messages whose source no longer matches a current
rendered widget.

### Widget state ↔ agent

Widget interaction state is a first-class, perceivable, persistent capability
(not a deferred extra). It is a bounded, declared, structured value — NOT a DOM
snapshot and NOT a stateful-app runtime (see Non-goals).

Contract:

- The shell exposes `lin.setState(obj)` to widget code; `obj` must be
  JSON-serializable and within a size cap (e.g. 8KB). The widget calls it on
  meaningful state changes (debounced).
- The shell exposes `lin.getState()` (or an init `set-state` message) returning
  the last persisted state on load, so the widget can re-initialize its controls.
  First render returns null → widget uses its own defaults.
- Under the hood this is one new allowlisted bridge message `state` (host
  validates: JSON object, size-capped, must match the currently-rendered
  `toolCallId`, last-write-wins, debounced).

Perception (pull on next turn):

- The agent does NOT react in real time. When the user next sends a message, the
  host gathers the current state of widgets in the active transcript path and
  injects a compact, clearly-labeled note into that turn's context, e.g.
  `Widget "Compound interest" (id …) current state: {years:25, rate:0.05}`.
- Only active-path widgets are injected; size-capped; last-write-wins. No
  per-interaction streaming into context.
- Widget-reported state is UNTRUSTED, model-authored content. Treat it like any
  tool output: bounded, escaped, never executed; label it as widget-reported and
  assume it may carry prompt-injection text.

Persistence: latest state is stored via a `widget_state.updated` event and
rehydrated on restore (see Persistence and replay).

### Persistence and replay

Persistence:

- Store the final `show_widget` tool call as existing assistant content.
- Do not persist every streaming delta.
- Persist the widget's latest interaction state via a `widget_state.updated`
  event (last-write-wins on replay), written at a checkpoint — the user's next
  turn and on widget teardown — not on every change. This is a protocol-surface
  addition: coordinate the `widget_state.updated` type on
  `src/core/agentEventLog.ts` / `src/core/types.ts` first (A4).
- On session restore, build the widget render projection from the completed tool
  call AND apply the latest `widget_state.updated`, so the controls and the
  agent's view of the state both rehydrate.

Payload handling:

- Large `widget_code` may exceed desirable event-log inline size. Use a
  conservative max widget size (e.g. 200KB); add payload refs for oversized widget
  code if real usage demands it.

Branching:

- Widget render state belongs to the assistant message branch containing the
  `show_widget` tool call.
- Switching branches should naturally switch visible widgets because projection
  follows the active transcript path.

Compaction:

- Compaction should preserve a textual summary of the visual result, not the
  full widget code, unless the widget remains in the visible active path.
- If the assistant tool call is compacted away, the visual does not need to
  remain renderable.

## Implementation Phases

This ships as ONE delivery, not incremental versions. The phases below are
build/integration order within that single delivery — not separate releases, and
none is a partial "MVP" that ships on its own. Order follows A7 (foundation before
consumers): settle the verified substrate, land the shared contracts (the
`AgentRenderProjection` widget entity, the `widget_state.updated` event, the bridge
message schema) interface-first, build the consumers in parallel, then integrate
and flip a single feature flag once the whole feature plus security probes pass.

### Phase 0: Substrate spike (gating)

The Chromium + Electron substrate test in Verified Findings already resolves the
iframe question. This phase closes the remaining packaged-runtime gaps before any
fan-out.

Files:

- `src/main/main.ts` (custom protocol registration, scoped CSP)
- a throwaway widget page served by the protocol

Tasks:

- Register `lin-widget://` privileged (`{ standard: true, secure: true }`) and a
  `protocol.handle` serving the widget shell with its own CSP.
- Widen renderer `frame-src` from `'none'` to `lin-widget:` only.
- Confirm a sandboxed (`allow-scripts`, no `allow-same-origin`) widget frame runs
  inline scripts, reports height, and `postMessage`s — in a packaged /
  CSP-enforced build, not just `dev:*`.
- Bundle `morphdom` locally (no remote patcher).
- Confirm the curated chart-lib CDN allowlist lives only in the widget-frame CSP,
  never the host renderer's.

Exit criteria:

- Packaged build shows a static, script-bearing widget rendering and staying
  isolated (no host DOM / `window.lin` / main-renderer navigation).
- PM approves the tool names, widget scope, scoped CSP, and the core bridge
  surface (`resize`, `open-link`, `state`).

### Phase 1: Model-facing tools (`show_widget` + `visualize_read_me`)

Files:

- `src/main/agentVisualTools.ts`
- `src/main/agentTools.ts`
- `docs/spec/agent-tool-design.md`
- tests under `tests/core/` if needed

Tasks:

- Add both tool surfaces — `show_widget` and `visualize_read_me` (names, parameter
  schemas, results). The rich guidance-module CONTENT is authored in the guidance
  workstream (Phase 6), but both tools exist from here.
- Integrate tool filtering with the current allowed/disallowed tool rules.
- Ensure `show_widget` returns a concise model-visible result.
- Add a summary/icon for `show_widget` in `AgentToolCallBlock`.

Exit criteria:

- Typecheck passes.
- A model can choose the tool.
- A final `show_widget` appears as a normal tool call (no rendering yet).

### Phase 2: Inline widget renderer + unified projection

Files:

- `src/renderer/ui/agent/AgentVisualWidget.tsx`
- `src/renderer/ui/agent/AgentMessageRow.tsx`
- `src/renderer/styles/agent-visual-widget.css`
- `src/renderer/styles/index.css`
- `src/core/agentRenderProjection.ts`
- renderer tests

Tasks:

- Route `show_widget` to `AgentVisualWidget` instead of the generic tool block.
- Define the unified `AgentRenderVisualWidgetEntity`; the renderer consumes only
  `{ html, status, currentState }`. Wire the completed-tool-call source here; the
  streaming source (Phase 5) feeds the SAME entity — one render path, no overlay.
- Implement the stable iframe shell over the `lin-widget://` protocol.
- Implement `set-content` and a single final `run-scripts`.
- Add loading, empty, error, and final states.
- Add auto-height reporting; preserve transcript layout/scroll.
- Add a way to expand/copy raw widget input for debugging.

Exit criteria:

- A completed SVG and an interactive HTML calculator both render; the calculator is
  interactive after finalize.
- Scripts run exactly once.
- Normal tool-call rendering still works for non-visual tools.
- The widget survives session restore/replay and branch switching (projection
  follows the active path).

### Phase 3: Security hardening

Files:

- `src/main/main.ts`
- `src/renderer/ui/agent/AgentVisualWidget.tsx`
- tests/e2e security smoke tests if practical

Tasks:

- Finalize the scoped CSP/frame change and the widget-frame CSP.
- Ensure iframe sandbox has only required capabilities.
- Validate and filter host bridge messages (schema + `toolCallId` match).
- Intercept iframe links and route external URLs through existing host policy.
- Block or ignore dangerous URL schemes.
- Confirm iframe cannot read host DOM or `window.lin` and cannot navigate the main
  renderer.

Exit criteria:

- Security tests or manual probes confirm host isolation.
- Existing renderer CSP guard expectations are updated deliberately.
- No broad `script-src`, `connect-src`, or `frame-src` relaxation.

### Phase 4: Widget state ↔ agent (perceivable + persistent)

Files:

- `src/renderer/ui/agent/AgentVisualWidget.tsx` (shell `lin.setState`/`getState`)
- `src/main/agentRuntime.ts` (gather active-path state, inject into next turn)
- `src/core/agentEventLog.ts`, `src/core/types.ts` (`widget_state.updated` event)
- `src/core/agentRenderProjection.ts` (`currentState` on the widget entity)
- tests under `tests/core/` and `tests/renderer/`

Tasks:

- Add the `state` bridge message + shell `setState`/`getState`; validate,
  size-cap, debounce, last-write-wins.
- Land the `widget_state.updated` event type as an interface-first PR (A4).
- Persist latest state via `widget_state.updated`; rehydrate on restore.
- On the user's next turn, inject active-path widgets' current state as a compact,
  clearly-labeled, untrusted context note — reuse the existing per-turn reminder
  assembly (`userViewContextReminderTracker` pattern); no new plumbing.

Exit criteria:

- Move a slider, then ask a follow-up: the agent sees the current value.
- Re-entering the session restores both the control state and the agent's view.
- State is bounded, debounced, active-path-only; nothing streams per-interaction.
- Branch switching shows the correct widget and its branch state.

### Phase 5: Progressive streaming capture

Files:

- `src/main/agentRuntime.ts`
- `src/core/agentRenderProjection.ts`
- `src/core/agentTypes.ts`
- `src/renderer/agent/runtime.ts`
- tests under `tests/core/agentRenderProjection.test.ts` and
  `tests/renderer/agentRuntimeStore.test.ts`

Tasks:

- Add transient `streamingVisualWidgets` state **per run** (off the executing `Run`, **not**
  the `AgentSessionState` singleton — F5, so concurrent widget-emitting runs don't clobber;
  see Runtime streaming state above); it feeds the unified projection entity defined in
  Phase 2 (same `{ html, status }`).
- Read `event.assistantMessageEvent` for `toolcall_start`, `toolcall_delta`,
  `toolcall_end`; track by `contentIndex` and `toolCallId`.
- Update the widget snapshot from partial parsed arguments; emit coalesced
  projections via the existing `message_update` path.
- Patch the widget DOM progressively (morphdom or local equivalent); keep scripts
  inert until finalize.
- Decide the fate of the existing dead `tool_call.delta` event type (reuse vs.
  leave unused) and record it.

Exit criteria:

- Unit tests prove partial `widget_code` reaches the projection before
  `message_end`.
- Providers with no fine-grained argument streaming still render via the
  completed-tool-call source (degraded path unaffected).
- No streaming delta is written to `events.jsonl`.

### Phase 6: `visualize_read_me` and Lin-specific guidance

Files:

- `src/main/agentVisualGuidance.ts` or equivalent
- `src/main/agentVisualTools.ts`
- `docs/spec/agent-tool-design.md`
- possibly `docs/spec/agent-event-log-rendering.md`

Tasks:

- Author the guidance-module content behind the `visualize_read_me` tool surface
  added in Phase 1.
- Add outliner-specific examples:
  - outline graph;
  - tag distribution;
  - field dashboard;
  - project timeline;
  - agent tool timeline.
- Add guidance for streaming-safe code:
  - style first;
  - HTML/SVG early;
  - scripts last;
  - no prose inside widgets;
  - bounded dimensions.
- Add guidance for dark/light themes using shell variables.

Exit criteria:

- Model reliably chooses `show_widget` for visual asks.
- Model does not overuse widgets for ordinary prose.
- Generated widgets fit the agent dock width.

### Phase 7: Host bridge polish

Tasks:

- Add `openLink(url)` if not already included.
- Decide and implement `sendPrompt(text)` if approved.
- Add copy/download controls if needed.
- Add accessibility labels and keyboard behavior.
- Add reduced-motion handling.
- Add high-contrast and dark/light verification.

Exit criteria:

- Widget interaction can lead to a safe follow-up path.
- Host bridge behavior is documented and tested.

## Testing Plan

Core/runtime tests:

- Captures `toolcall_delta` partial args for `show_widget`.
- Ignores partial args for non-visual tools.
- Handles interleaved text and tool-call events by `contentIndex`.
- Handles provider behavior with one final full tool delta.
- Projects final widgets from restored assistant tool calls.
- Does not persist every streaming delta.

Renderer tests:

- `AgentMessageRow` routes `show_widget` to `AgentVisualWidget`.
- Widget displays loading state for empty/short code.
- Widget sends `set-content` updates on html changes.
- Widget sends finalization once.
- Non-visual tool calls still use `AgentToolCallBlock`.

E2E/manual tests:

- Ask for a simple SVG diagram and watch it stream.
- Ask for a compound-interest calculator with sliders.
- Ask for a chart using Chart.js from an allowlisted CDN.
- Verify scripts do not run during streaming.
- Verify iframe cannot access `window.parent.document`.
- Verify iframe cannot access `window.lin`.
- Verify malicious links do not navigate the app.
- Verify session restore displays the final widget.
- Verify branch switching hides/shows the correct widget.

Commands:

```sh
bun run typecheck
bun run test:core
bun run test:renderer
bun run test:e2e
```

Run targeted subsets while developing, then the broader set before merge.

## Rollout

Recommended rollout (single delivery):

1. Build the whole feature behind one feature flag / runtime setting; everything
   lands together.
2. Land the shared contracts (projection widget entity, `widget_state.updated`
   event, bridge schema) interface-first so parallel work builds on a stable shape.
3. Keep the flag off until security probes pass and the feature is fully integrated.
4. Flip the flag on once verified in a packaged / CSP-enforced build.

## Open Questions

- Should `show_widget` be enabled for every provider or only providers known to
  stream tool arguments well?
- (Resolved) Bundle `morphdom` locally; the patcher is never remote.
- (Resolved — see Verified Findings) The iframe substrate is a custom
  `lin-widget://` protocol, not `srcdoc`/`blob:`, which inherit the renderer CSP
  and block widget scripts.
- (Resolved — PM 2026-06-03) Widget interaction state IS agent-perceivable and
  persistent: a declared structured value, pulled into the agent's next turn (no
  real-time push), persisted via `widget_state.updated`, and rehydrated on
  restore. Remaining detail for Phase 4: state size cap, debounce interval, and
  treating reported state as untrusted (prompt-injection).
- (Resolved) Widget `img-src` stays `data:` only; no remote images, so a
  CDN-loaded script has no image-based exfiltration channel.
- (Resolved) `sendPrompt(text)` is out of scope for this delivery (a separate
  feature; see Non-goals / Host bridge).
- What is the maximum acceptable `widget_code` size before using payload refs?
- Should visual widgets appear in transcript export, and if so as final HTML,
  a placeholder, or a screenshot?

## Implementation Ownership Notes

This is a plan-track change because it touches tool protocol, event projection,
renderer security, and agent transcript rendering.

The Phase 0 substrate spike (custom protocol + scoped CSP + iframe shell) plus the
shared contracts (projection widget entity, `widget_state.updated` event, bridge
schema) are the gate: fan-out begins only after they land, because every consumer
depends on those shapes. Spreading agents before they are settled risks rework
(A7). It all integrates into one delivery.

Suggested parallel split, after Phase 0 and the contracts land:

- Agent A: `show_widget` + `visualize_read_me` tool surfaces (Phase 1).
- Agent B: inline widget renderer, iframe shell, styles, tests, and the unified
  projection entity (Phase 2).
- Agent C: security/CSP hardening and e2e probes (Phase 3).
- Agent D: widget state ↔ agent — `state` bridge, `widget_state.updated`,
  rehydration, and next-turn context injection (Phase 4).
- Agent E: progressive streaming capture feeding the unified projection (Phase 5).
- Agent F: guidance-module content behind `visualize_read_me` (Phase 6).

The agents should coordinate on the `AgentRenderProjection` shape before writing
consumer code. If the projection type is still in flux, land an interface-only
PR first.
