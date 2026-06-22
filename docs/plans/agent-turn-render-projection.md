# Agent turn render projection

## Goal

Make the agent transcript rendering pipeline match Codex.app's message-flow
shape without replacing Tenon's event log, pi-mono runtime boundary, or
domain-specific reasoning/tool detail renderers.

The change introduces a small Codex-like turn render projection between
`AgentRenderProjection` message entities and React components. The projection owns
the turn-level semantics that are currently scattered across the assistant
message renderer:

- process-vs-final answer partitioning;
- the synthetic `Working` / `Working for ...` / `Worked for ...` process item;
- default process fold state inputs;
- stable disclosure ids for process, reasoning, tool rows, and activity groups;
- tool-activity grouping boundaries.

## Non-goals

- Do not replace Tenon's event store with Codex `ThreadItem`.
- Do not expose pi-mono runtime objects to the renderer.
- Do not change the visual design of reasoning rows or tool detail rows in this
  PR. Reasoning remains Tenon's concise "Thinking" / "Thought" row with an inline
  gist, and tool details remain Tenon's domain-aware `AgentToolCallBlock`.
- Do not implement Codex MCP app/resource persistence or dynamic tool grouping in
  full. The projection should leave clear extension points for persistent items,
  but the current tool surface stays Tenon-specific.
- Do not edit `docs/TASKS.md` or `CHANGELOG.md` from this dev clone.

## Design

Add a pure renderer-side projection module, initially
`src/renderer/ui/agent/agentTurnProjection.ts`, that transforms one assistant
message row plus its turn runtime metadata into a compact render model:

```ts
type AgentTurnRenderItem =
  | { type: 'reasoning'; id: string; sourceIndex: number; text: string; streaming: boolean }
  | { type: 'agentMessage'; id: string; sourceIndex: number; phase: 'process' | 'final'; text: string; streaming: boolean }
  | { type: 'toolCall'; id: string; toolCall: ToolCall; childRun?: AgentRenderChildRunEntity; outcome?: AgentToolCallOutcome };

type AgentTurnProcessProjection = {
  id: string;
  items: AgentTurnRenderItem[];
  answerStarted: boolean;
  sealed: boolean;
  surfaceResultlessProcess: boolean;
  turnFailedWithoutProse: boolean;
  workedForMs: number | null;
  liveStartedAtMs: number | null;
};

type AgentTurnProjection = {
  process: AgentTurnProcessProjection | null;
  finalMessages: Extract<AgentTurnRenderItem, { type: 'agentMessage' }>[];
};
```

The projection keeps today's fallback heuristic for identifying the final answer:
the final answer is trailing text after the last reasoning/tool item. The
heuristic moves out of `AgentAssistantTurnContent` so the component stops owning
message-flow semantics. If a future runtime records an explicit assistant
message phase, the projection becomes the single place to consume it.

`AgentProcessBlock` should receive a process projection rather than raw assistant
content items. It continues to compute the visible summary and live clock, but
the fold defaults should be derived from projection fields rather than repeating
turn partition logic.

`AgentProcessTimeline` should render projected process items. Tool grouping moves
from "raw block run" to "projected item run"; the current Tenon exceptions remain:
reasoning, process narration, child-run tools, and loaded-skill chips break a
tool run; a lone tool renders standalone.

Disclosure state remains in `agentDisclosureStore`, but keys should come from the
projection:

- process: `turn:${message-or-run-id}:process`;
- reasoning: `${processId}:reasoning:${sourceIndex}`;
- tool row: `tool:${toolCall.id}`;
- activity group: `${processId}:activity:${firstToolCallId}`.

This keeps user overrides stable across component remounts and keeps React
components from inventing ids independently.

## Open questions

- Should the runtime eventually stamp an explicit `phase: 'process' | 'final'`
  on assistant text parts, or is the trailing-text heuristic sufficient until the
  next event-log pass?
- Should persistent collapsed entries be modeled now as
  `collapsedBehavior: 'collapsible' | 'persistent'`, even if no current item uses
  the persistent branch?

## Implementation checklist

- Add the projection module and renderer tests for final-answer partitioning,
  active/resultless/interrupted state, and stable ids.
- Refactor `AgentAssistantTurnContent` to call the projection and render final
  message items only.
- Refactor `AgentProcessTimeline` / grouping to consume projected process items.
- Preserve current reasoning and tool detail components.
- Run focused renderer tests plus typecheck.
