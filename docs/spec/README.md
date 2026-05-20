# Lin Specs

This directory is the agent-readable product specification map for Lin
Outliner. Use this file first, then jump to the smallest document that owns the
question you are answering.

## Reading Order

For general product work:

1. `architecture.md`
2. `commands.md`
3. `workspace-layout.md`
4. `design-system.md`
5. `ui-behavior.md`

For outliner interaction work:

1. `ui-behavior.md`
2. `outliner-parity-matrix.md`
3. `design-system.md`
4. `commands.md`

For agent work:

1. `agent-event-log-rendering.md`
2. `agent-pi-mono-implementation.md`
3. `agent-tool-design.md`
4. `agent-chat-rendering.md`
5. `agent-progress.md`

## Canonical Documents

| File | Owns | Read When |
| --- | --- | --- |
| `architecture.md` | Runtime boundaries, command flow, renderer/main/core ownership. | Changing broad architecture or deciding where logic belongs. |
| `commands.md` | Electron IPC document command list. | Adding, renaming, or auditing document mutations. |
| `workspace-layout.md` | Shell, tabs, workspace canvas, tiled panels, sidebar, and agent dock layout. | Changing app frame or panel layout behavior. |
| `design-system.md` | Visual system, density, typography, tokens, surfaces, components, and UI contracts. | Changing UI visuals, primitives, overlay styling, outliner row rhythm, or agent dock styling. |
| `ui-behavior.md` | Compact outliner keyboard, pointer, trailing input, field row, selection, and trigger behavior. | Making everyday outliner interaction changes. |
| `outliner-parity-matrix.md` | Detailed nodex parity checklist and test mapping. | Checking exact nodex-style selection/editing parity. |
| `agent-event-log-rendering.md` | Canonical event-sourced agent data, debug, persistence, and render projection architecture. | Changing agent state, event store, debug, persistence, replay, or render projection. |
| `agent-pi-mono-implementation.md` | pi-mono runtime boundary and Electron integration. | Changing provider loop, runtime execution, approvals, keys, streaming, or pi-mono adapter behavior. |
| `agent-tool-design.md` | Public agent tool protocol and tool behavior contracts. | Adding or changing agent tools. |

## Supporting Documents

| File | Role |
| --- | --- |
| `agent-chat-rendering.md` | Rendering-focused reference for the current agent panel. Event store architecture remains canonical in `agent-event-log-rendering.md`. |
| `agent-progress.md` | Working checklist for agent milestones and remaining work. Keep this current when agent priorities change. |

## Ownership Rules

- Product code is still the executable source of truth. Specs define intended
  contracts and should move with behavior changes.
- Prefer one canonical document per concern. Do not add a new spec if an
  existing file owns that area.
- Keep `design-system.md` as a single file. It is optimized for agents reading
  source context, not for a browsable design site.
- Keep outliner behavior in `ui-behavior.md` unless the change needs detailed
  nodex parity evidence; then update `outliner-parity-matrix.md` too.
- Keep durable agent architecture in `agent-event-log-rendering.md`. Other
  agent files should link back to it instead of restating the model.
- Remove or merge stale docs when a document becomes only a duplicate summary.

## Validation

When changing specs, run the smallest relevant checks:

- `bun run typecheck`
- `bunx playwright test tests/e2e/typography-tokens.spec.ts --project=chromium`
  for design-system token changes.
- Focused Playwright or core tests for the behavior being documented.
- `git diff --check`
