# Agent Chat Rendering

This document describes the rendering strategy for the future agent panel.
It is an implementation reference, not a commitment that the first agent
release must ship every optimization listed here.

For the canonical event-sourced agent runtime and render projection plan, see
`docs/spec/agent-event-log-rendering.md`. For the pi-mono runtime boundary, see
`docs/spec/agent-pi-mono-implementation.md`.

## Goals

- Agent streaming must not stall outliner editing, selection, or scrolling.
- Token streams must not update the document projection on every chunk.
- Long conversations, tool logs, diffs, and search results must remain usable
  after many agent turns.
- Completed transcript content should become stable and cheap to keep on
  screen.
- Agent reads and edits the outliner through tools. It does not directly own or
  mutate outliner UI state.

## Non-Goals

- Do not copy terminal-specific rendering from Claude Code. Lin Outliner is an
  Electron and React application, not a terminal UI.
- Do not put agent stream state into `DocumentProjection`.
- Do not make the agent panel a child of a single outline panel.
- Do not let every streamed token produce a full React tree update.

## Boundary

The agent panel is a cross-tab dock in the app shell. It owns conversation
rendering. The outliner owns document rendering.

```txt
App Shell
  -> Sidebar dock
  -> Tab bar
  -> Active workspace canvas
  -> Agent dock

Agent dock
  -> AgentStore
  -> Transcript renderer
  -> Tool call renderer
  -> Input composer

Outliner
  -> DocumentProjection
  -> DocumentIndex
  -> Outline panels
  -> Selection and editor state
```

The bridge between the agent and the outliner is a tool layer. Agent tools may
read document snapshots, inspect the active tab context, and request document
mutations through existing command paths.

## State Ownership

Agent state should be separate from document state.

```ts
interface AgentState {
  activeConversationId: string | null;
  conversations: Map<string, AgentConversation>;
  streaming: AgentStreamingState | null;
}

interface AgentConversation {
  id: string;
  title: string;
  messages: AgentMessage[];
  runs: AgentRun[];
  createdAt: number;
  updatedAt: number;
}

interface AgentRun {
  id: string;
  conversationId: string;
  status: 'queued' | 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled';
  events: AgentEvent[];
  startedAt: number;
  finishedAt?: number;
}
```

`DocumentProjection` remains the outliner view of committed document state.
Agent text streaming, chain-of-thought summaries, tool progress, and transient
diff previews belong to `AgentState`, not to the projection.

## Stream Pipeline

Agent streaming should use a buffered pipeline:

```txt
network/model/tool stream
  -> append raw events to run buffer
  -> coalesce text chunks by animation frame
  -> update only current streaming message
  -> freeze completed blocks
  -> virtualized transcript renders visible rows
```

Do not call React `setState` once per token. The stream handler should append
incoming chunks into a mutable buffer and schedule a single UI update with
`requestAnimationFrame` or a 16ms throttle.

```ts
function appendAgentChunk(chunk: string) {
  pendingText += chunk;
  if (frameScheduled) return;
  frameScheduled = true;
  requestAnimationFrame(() => {
    frameScheduled = false;
    commitStreamingText(pendingText);
    pendingText = '';
  });
}
```

For non-visual bookkeeping, keep the raw event log append-only. For visual
rendering, derive compact render rows from the event log.

## Message Lifecycle

Messages should have a lifecycle that makes completed content cheap.

```ts
type AgentMessageStatus =
  | 'streaming'
  | 'complete'
  | 'failed'
  | 'cancelled';

interface AgentTextMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  status: AgentMessageStatus;
  content: string;
  createdAt: number;
  updatedAt: number;
}
```

Rules:

- Only the active streaming assistant message changes on token updates.
- Completed messages are immutable by identity.
- Tool result rows are immutable after their tool call completes.
- Error state attaches to the run or message without rewriting older rows.
- Retrying a turn creates a new run rather than mutating the old transcript in
  place.

## Incremental Markdown

Streaming markdown should follow the Claude Code principle: split content at
the last safe block boundary. Stable prefix content is parsed once. Only the
currently growing suffix is re-parsed.

```txt
assistant content
  -> stablePrefix: completed top-level blocks
  -> unstableSuffix: current paragraph/list/code fence/table
```

Renderer behavior:

- Plain text fast path: if no markdown markers are present, render as text and
  skip markdown parsing.
- Stable prefix cache: cache parsed markdown by content hash or message id plus
  content version.
- Growing suffix: parse every frame at most, not every token.
- Code fence handling: an unclosed fence stays in the unstable suffix until it
  closes.
- Syntax highlighting: avoid synchronous high-cost highlighting per token.
  Highlight completed code blocks, or highlight streaming code blocks on a
  throttled schedule.

Pseudo shape:

```ts
interface ParsedStreamingMarkdown {
  stablePrefix: string;
  unstableSuffix: string;
  stableAst: MarkdownAst;
  unstableAst: MarkdownAst;
}
```

## Transcript Virtualization

The agent transcript can become much larger than the visible panel. It should
be virtualized from the first serious implementation.

Minimum behavior:

- Render visible rows plus overscan.
- Keep stable estimated heights for unmeasured rows.
- Measure row heights after render and update the height cache without forcing
  an immediate second render.
- Preserve scroll position when older rows mount or unmount.
- Keep the bottom pinned only while the user is already at the bottom.

Important row types:

```ts
type AgentRenderRow =
  | { type: 'message'; messageId: string }
  | { type: 'tool_call'; toolCallId: string }
  | { type: 'tool_result'; toolCallId: string }
  | { type: 'diff_preview'; patchId: string }
  | { type: 'approval'; approvalId: string }
  | { type: 'run_status'; runId: string };
```

The renderer should derive `AgentRenderRow[]` from the event log. Tool events
that are noisy or long should be collapsed into a small row by default.

## Scroll Behavior

The agent panel should behave like a chat surface, but it must not fight the
user.

- If the user is at the bottom, new streaming content keeps the transcript
  pinned to the bottom.
- If the user scrolls up, new content does not force-scroll them down.
- When content arrives while the user is away from the bottom, show a compact
  "new messages" affordance.
- Tool output expansion should preserve the nearest visible anchor.
- Switching tabs should not reset agent scroll position unless the user starts
  a new conversation or explicitly jumps to latest.

## Tool Output Rendering

Tool calls are expected to be frequent. The UI should summarize by default.

Tool call row:

- Tool name.
- Status: queued, running, waiting for approval, completed, failed.
- Short argument summary.
- Duration when complete.
- Expand affordance for full details.

Tool result row:

- Short result summary by default.
- Structured rendering for known tool types.
- Collapsed long stdout or search results.
- Expand-on-demand for raw payloads.

Long output rules:

- Do not render thousands of lines as normal DOM.
- Use line virtualization for large plain-text outputs.
- Provide copy/export affordances for raw output.
- Keep collapsed rows stable in height to avoid scroll jumps.

## Outliner Tool Bridge

The agent should use a narrow tool protocol to interact with the outliner.
Tools can be split into global document tools and active-tab context tools.

Global document tools:

```ts
readNode(id: NodeId): Promise<NodeProjection>;
searchNodes(query: string): Promise<NodeProjection[]>;
getNodeChildren(id: NodeId): Promise<NodeProjection[]>;
applyNodeTextPatch(id: NodeId, patch: RichTextPatch): Promise<DocumentProjection>;
insertNode(input: InsertNodeInput): Promise<DocumentProjection>;
moveNode(input: MoveNodeInput): Promise<DocumentProjection>;
batchEdit(ops: DocumentEditOp[]): Promise<DocumentProjection>;
```

Active-tab context tools:

```ts
getActiveTab(): Promise<WorkspaceTabSnapshot>;
getOpenPanels(tabId: string): Promise<OutlinePanelSnapshot[]>;
getActivePanel(tabId: string): Promise<OutlinePanelSnapshot | null>;
getCurrentSelection(tabId: string): Promise<PanelSelectionSnapshot | null>;
openNodeInPanel(tabId: string, nodeId: NodeId): Promise<void>;
```

Mutating tools must go through the same TypeScript-backed command flow as human UI
actions:

```txt
Agent tool request
  -> validation and optional approval
  -> Electron IPC command
  -> TypeScript core mutation
  -> persisted snapshot
  -> DocumentProjection returned to React
```

## Applying Edits

Agent edits should be batched and undoable.

Rules:

- Do not stream document edits token by token.
- Prefer a patch plan or a batch command.
- Every applied mutation should be represented as one coherent undo step unless
  the user explicitly approves a multi-step operation.
- Risky edits should present an approval row in the agent transcript.
- Previewable edits should render a diff preview before apply.

Example edit event flow:

```txt
assistant proposes edit
  -> tool call creates patch preview
  -> user approves
  -> batchEdit applies patch
  -> projection updates once
  -> transcript records applied result
```

## React Rendering Guidelines

- Keep `AgentPanel` outside the outliner subtree so agent streaming does not
  re-render outline panels.
- Use memoized row components for completed transcript rows.
- Keep callback props stable for virtualized rows.
- Avoid passing large arrays or whole maps into every row.
- Use derived selectors so a row subscribes only to the data it needs.
- Use an external store or reducer for agent state if normal React state causes
  broad invalidation.

## Performance Checks

Before enabling agent by default, test these scenarios:

- 10,000 token assistant response while editing an outline row.
- 500 transcript rows with mixed markdown, tool calls, and diffs.
- A tool result with 10,000 lines of output.
- User scrolls up during streaming and remains anchored.
- Agent applies a batch edit to the outliner while transcript is streaming.
- Rapid tab switching while agent continues streaming.

Expected result: the outliner remains responsive, the agent input remains
editable, and transcript rendering does not produce visible stalls.
