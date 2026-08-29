# Agent Generative UI

## Goal

Let a model produce bounded HTML/SVG visualizations and small interactive tools
that render inline as the visible presentation of a canonical
`dynamicToolCall` ThreadItem. The widget should appear progressively while tool
arguments stream, execute scripts only after completion, preserve its latest
declared interaction state, and make that state available to the next Turn.

This is one complete feature. Because progressive arguments and widget state add
shared Agent protocol fields, the repository's interface-first rule requires a
human-led contract PR before the implementation PR. The contract PR is a
complete, codec-tested protocol change with no alternate runtime; the following
implementation PR ships the entire user-visible capability in one delivery.

## Non-goals

- No arbitrary desktop or browser automation from inside a widget.
- No iframe access to Outliner commands, filesystem, shell, MCP, clipboard,
  credentials, host DOM, preload APIs, or unrestricted network.
- No general app-builder runtime, package manager, module graph, long-lived
  background process, or editable source workspace.
- No automatic prompt submission from a widget. A later user message remains a
  normal `userMessage` in a new Turn.
- No alternate Agent history, render projection, or widget transcript.
- No remote image fetching, arbitrary CDN dependencies, or compatibility reader
  for old widget data.
- No visual replacement for ordinary prose, simple tables, code, or static
  images when those are the clearer result.

## Design

### Canonical tools and Items

The model-facing surface contains two plain tools:

- `visualize_read_me` returns concise guidance and examples for deciding when a
  widget is appropriate, producing streaming-safe markup, using theme tokens,
  and staying within security/size limits.
- `show_widget` accepts title, bounded width/min-height, `widget_code`, and an
  optional initial JSON state object. Its result is a short confirmation, not a
  second copy of the markup.

Both tools are registered through the canonical model-tool registry and obey the
effective Thread catalog, explicit blocks, provider encoding, and Full Access
audit like any other dynamic tool. A Profile, Role, Skill, plugin, or child
Thread cannot add either tool above its parent capability ceiling.

The authoritative history object is the ordinary `dynamicToolCall` Item whose
canonical identity is `show_widget`. While the provider streams its arguments,
the Item has `status: 'inProgress'`; `item/delta` appends bounded raw argument
chunks. At tool completion the normalizer emits one decoded, terminal Item with
the final arguments and result. Completed Items remain immutable.

No second widget entity is projected from history. `ThreadItemView` recognizes
the canonical tool identity and delegates that Item to `VisualWidgetItem`;
unknown or invalid widget input falls back to the generic JSON tool disclosure.

### Interface-first contract

The shared protocol change is deliberately small:

```ts
type ThreadItemDelta =
  | ExistingThreadItemDelta
  | {
      type: 'dynamicToolArguments';
      delta: string;
    };

interface VisualWidgetStateSnapshot {
  threadId: ThreadId;
  itemId: ItemId;
  revision: number;
  value: Readonly<Record<string, unknown>>;
  updatedAt: number;
}
```

`dynamicToolArguments` is valid only for an in-progress `dynamicToolCall` Item.
Codecs reject the delta for every other Item type or after completion. Rollout
replay appends chunks in order and the terminal Item replaces the partial
arguments, so pagination and replay converge on the same canonical Item.

Widget interaction state is extension state owned by the originating Item, not a
new execution entity. Typed host requests read and compare-and-set the snapshot;
a notification carries accepted revisions to the renderer. These host methods
are not model tools and do not add user-visible Agent nouns.

The contract PR includes exhaustive codecs, invalid phase/type combinations,
size limits, revision conflicts, replay convergence, fork initialization, and
delete cleanup. It does not register tools, render a frame, or keep an old path.

### Progressive argument capture

The provider adapter associates partial tool arguments by provider tool-call ID
and content index, then binds that identity to one local Item ID. Interleaved
text, reasoning, and multiple tool calls never rely on adjacency.

Argument chunks are appended, not emitted as repeated full snapshots. The
normalizer coalesces them to at most one durable `item/delta` per animation-frame
equivalent or 50–80 ms, while never delaying the terminal Item. Per-Item and
per-Turn byte limits abort malformed or oversized widget input before unbounded
rollout growth.

The renderer uses a defensive incremental JSON-string extractor to expose the
current `widget_code`, title, and dimensions. Partial syntax is expected. The
terminal decoded arguments replace every speculative value, and providers that
do not expose fine-grained argument deltas simply show a compact loading state
until the completed Item arrives.

The final `widget_code` limit is fixed and conservative, initially no more than
200 KiB. Oversized widgets fail visibly; they are not diverted into another
widget byte store.

### One renderer path

Add `VisualWidgetItem` under the current Thread Item component tree and a
dedicated stylesheet using existing design tokens. Its input is:

```ts
interface VisualWidgetView {
  itemId: ItemId;
  title: string;
  html: string;
  width: number;
  minHeight: number;
  status: 'streaming' | 'complete' | 'error';
  state: Readonly<Record<string, unknown>> | null;
}
```

Streaming and restored content feed this same view:

- an in-progress Item supplies partial HTML and `streaming`;
- a completed Item supplies final HTML and `complete`; and
- the extension snapshot supplies current interaction state.

The renderer shows a stable frame, compact loading/empty/error states, and a
debug disclosure for bounded raw tool input. It does not render a widget inside
another decorative card. Width is constrained by the Thread column; min/max
height and an aspect-safe fallback prevent layout jumps.

During streaming, markup patches the frame DOM at a bounded cadence while all
scripts remain inert. Finalization applies the terminal HTML and executes script
nodes exactly once. A locally bundled DOM patcher may preserve controls and
scroll state; no patcher or library is fetched from the network.

### Isolated widget document

Serve the widget shell from a privileged internal `tenon-widget://` protocol.
The host renderer CSP permits that scheme only in `frame-src`. The frame uses:

```html
<iframe sandbox="allow-scripts">
```

It never receives `allow-same-origin`, navigation, forms, popups, downloads,
clipboard, or presentation privileges. The widget document has its own strict
CSP:

- `default-src 'none'`;
- scripts limited to the shell and final inline widget code;
- styles limited to the shell and inline widget styles;
- images limited to bounded `data:`/host-created `blob:` content;
- `connect-src`, `frame-src`, `object-src`, `media-src`, and form submission
  disabled unless a later separately reviewed capability changes them.

Curated chart helpers, if provided, are bundled and served by the internal
protocol. Model-authored remote script URLs are stripped. This prevents a widget
from using a variable CDN path as an exfiltration channel.

The shell exposes only internal DOM helpers and theme variables. It cannot see
`window.lin`, the host document, Thread APIs, or Node. It honors light/dark,
reduced motion, reduced transparency, and increased contrast without a renderer
theme bridge.

### Host bridge

The host accepts three frame messages:

```ts
type WidgetToHost =
  | { type: 'resize'; height: number }
  | { type: 'open-link'; url: string }
  | { type: 'state'; baseRevision: number; value: Record<string, unknown> };
```

Routing matches `event.source === iframe.contentWindow`. A sandboxed frame has
an opaque origin, so `event.origin` cannot identify the Item. Any Item ID carried
inside a message is only a cross-check and never the authority.

Validation rules:

- resize is clamped to the Item's stable min/max bounds;
- links accept only normalized `http(s)` URLs and use the existing main-owned
  external-open policy;
- state must be plain JSON, depth/key/string/total-byte capped, and no larger
  than 16 KiB initially;
- updates are debounced, compare `baseRevision`, and are last-write-wins only
  after a successful revision check; and
- messages from stale/unmounted frames are ignored.

There is no generic RPC, arbitrary command name, eval bridge, file read, or
`sendPrompt` message.

### State, Turn admission, and persistence

`VisualWidgetStateExtension` stores the latest bounded snapshot under
`(threadId, itemId)`. The Item must exist in that Thread's visible history and
must be a completed `show_widget` call before a state update commits. The store
contains current interaction state only; code/title/dimensions remain in the
immutable Item.

Before the next root user Turn is accepted, the extension reads current state
for visible widgets and contributes a compact additional-context block:

```text
Widget-reported state (untrusted)
- "Compound interest" [item …]: {"years":25,"rate":0.05}
```

The admission snapshot is size-capped and explicitly classified as untrusted
model-authored content. It cannot add tools, developer instructions, or system
authority. State changes during an active Turn become visible only to the next
Turn; they do not mutate accepted context underneath a running model.

On restart, completed Items come from rollout/history and current state comes
from the extension store. Thread deletion removes owned state. A history-only
fork copies snapshots for included widget Items at the fork boundary into the
new Thread, keyed by the shared Item provenance; subsequent state changes are
independent between source and fork. Edit/regenerate creates a new fork and
therefore never rolls back external widget interaction in the source Thread.

Compaction may summarize a visual result for model context, but it does not
rewrite the completed Item or state store. If an Item is no longer in the
visible history window, its state is omitted from Turn admission.

### Tool guidance

`visualize_read_me` teaches the model to use widgets only when interaction or
spatial explanation materially improves understanding. Guidance includes:

- style/theme tokens first, meaningful HTML/SVG structure early, scripts last;
- no prose-heavy answer hidden inside a frame;
- stable dimensions and labels that fit their controls;
- accessible keyboard/focus semantics and motion preferences;
- no network assumptions;
- deterministic examples for graphs, timelines, simulations, comparison tools,
  and small calculators; and
- a textual summary outside the widget when the result is needed for search,
  accessibility, or later model context.

The guidance is versioned with the tool implementation and does not create a
Skill binding requirement.

### Failure behavior

- Invalid/empty arguments render the normal failed tool disclosure.
- A frame protocol or CSP failure leaves the terminal Item and raw disclosure
  inspectable.
- Script errors are contained inside the frame and surfaced as a bounded widget
  error; they do not fail the completed Turn retroactively.
- A stale state revision reloads the current snapshot before another user edit.
- Unsupported providers degrade to final-only rendering.
- All errors use Item/Thread identifiers in diagnostics without exposing widget
  HTML or state values by default.

### Verification

Protocol/Core tests cover delta phase/type validation, byte caps, terminal
replacement, replay, state revisions, admission snapshots, fork divergence, and
deletion. Runtime tests cover interleaved provider content indexes, final-only
providers, cancellation, malformed partial JSON, and completion ordering.

Renderer tests cover streaming/final use of one component, script execution once,
fallback disclosure, state restore, stable dimensions, cleanup, and non-widget
dynamic tools. E2E/security probes verify packaged CSP behavior, frame isolation,
blocked host/preload/network access, link filtering, stale-frame rejection,
light/dark rendering, reduced preferences, restart restore, next-Turn state
perception, and fork divergence. Canvas/pixel checks confirm representative SVG
and interactive widgets are nonblank and correctly framed.

The implementation PR runs typecheck, Core and renderer suites, focused and full
E2E as required, docs check, design-system guards, and diff check before it is
marked ready.

## Open questions

- What exact final widget byte limit and state byte limit survive representative
  charts without making rollout or Turn context unbounded?
- Which small visualization helpers are worth bundling into the isolated shell?
- Should transcript export include final sanitized HTML, a static screenshot, or
  a typed placeholder plus textual summary?
