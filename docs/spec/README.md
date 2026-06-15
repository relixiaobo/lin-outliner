# Lin Specs

This directory is the agent-readable product specification map for Lin
Outliner. Use this file first, then jump to the smallest document that owns
the question you are answering.

`spec/` describes **current intended behavior** of code that exists. Forward-
looking plans live in [`../plans/`](../plans/) (indexed on
[`../TASKS.md`](../TASKS.md)).

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

0. `agent-architecture.md` ← read first: the map
1. `agent-event-log-rendering.md`
2. `agent-pi-mono-implementation.md`
3. `agent-skills.md`
4. `agent-delegation-runtime.md`
5. `agent-tool-design.md`
6. `agent-tool-permissions.md`
7. `agent-progress.md`

## Canonical Documents

| File | Owns | Read When |
| --- | --- | --- |
| `architecture.md` | Runtime boundaries, command flow, renderer/main/core ownership. | Changing broad architecture or deciding where logic belongs. |
| `commands.md` | Electron IPC document and agent command surface. | Adding, renaming, or auditing commands. |
| `workspace-layout.md` | Shell, tabs, workspace canvas, tiled panels, sidebar, and agent dock layout. | Changing app frame or panel layout behavior. |
| `design-system.md` | Visual system, density, typography, tokens, surfaces, components, and UI contracts. | Changing UI visuals, primitives, overlay styling, outliner row rhythm, or agent dock styling. |
| `ui-behavior.md` | Compact outliner keyboard, pointer, trailing input, field row, selection, and trigger behavior. | Making everyday outliner interaction changes. |
| `error-observability.md` | Local structured diagnostic logging, error reporting, safety nets, and Settings export/reveal actions. | Changing runtime failure reporting, diagnostic log storage, renderer/main error bridges, or diagnostics export. |
| `outliner-parity-matrix.md` | Behavioral parity with nodex: pointer, keyboard, selection, trigger semantics, and the tests that pin them. | Checking exact nodex-style selection/editing parity. |
| `search-query-grammar.md` | Search node query expression and operator semantics. | Changing query operators, search node persistence, or live refresh. |
| `date-field-values.md` | Date field value model, parsing, and display rules. | Changing date fields. |
| `agent-architecture.md` | The one-page map of the agent subsystem: the 7 primitives (Principal, Conversation, Run, Memory, Skill, Agent, Permission gate), the three ledgers, sub-agent vs peer relationships, the user+self-agent concept direction, and the verified built/scaffolded/planned status. | Onboarding to the agent subsystem, or deciding which deeper doc/plan to read. |
| `agent-event-log-rendering.md` | Canonical event-sourced agent data, debug, persistence, and render projection architecture. | Changing agent state, event store, debug, persistence, replay, or render projection. |
| `agent-pi-mono-implementation.md` | pi-mono runtime boundary and Electron integration. | Changing provider loop, runtime execution, approvals, keys, streaming, or pi-mono adapter behavior. |
| `agent-skills.md` | Skill discovery, loading, slash invocation, compaction restore, and restricted skill tool preapproval. | Changing agent skills, `/compact`, `/dream`, restricted skill tool access, or skill settings. |
| `agent-delegation-runtime.md` | Same-session Agent/delegation runtime (child runs), cc-2.1 alignment, non-goals, tools, implementation status, and tests. | Changing delegation, fork/fresh child runs, background child runs, sidechain transcripts, or skill `execution: isolated`. |
| `agent-tool-design.md` | Public agent tool protocol and tool behavior contracts. | Adding or changing agent tools. |
| `agent-tool-permissions.md` | The runtime allow/ask/deny permission policy: effects, safety floor, narrow grants, bash projection, the permission store, and events. | Changing how tool calls are allowed/asked/denied, hard blocks, grants, or the permission store. |
| `launcher.md` | The global launcher: prewarmed window + NSPanel, hotkey, A3 security posture, the modeless capture/search model, basic-info capture + providers, inline node search, and the `launcher:*` IPC surface. | Changing the launcher window, capture, node search, or its commands/IPC. |
| `i18n.md` | Internationalization: the typed message layer, locale selection/persistence, the language broadcast + native-menu rebuild, no-flash startup, and how to add a language. | Changing localized text, the language preference, or adding a locale. |

## Supporting Documents

| File | Role |
| --- | --- |
| `agent-progress.md` | Working checklist for agent milestones and remaining work. Keep this current when agent priorities change. |

## Ownership Rules

- Product code is the executable source of truth. Specs define intended
  contracts and must move with behavior changes.
- Prefer one canonical document per concern. Do not add a new spec if an
  existing file owns that area.
- Keep `design-system.md` as a single file. It is optimized for agents reading
  source context, not for a browsable design site.
- Keep outliner behavior in `ui-behavior.md` unless the change needs detailed
  nodex parity evidence; then update `outliner-parity-matrix.md` too.
- Keep durable agent architecture in `agent-event-log-rendering.md`. Other
  agent files should link back to it instead of restating the model.
- Forward-looking work goes to [`../plans/`](../plans/), not here.
- Remove or merge stale docs when a document becomes only a duplicate summary.

## Validation

When changing specs, run the smallest relevant checks:

- `bun run typecheck`
- `bunx playwright test tests/e2e/typography-tokens.spec.ts --project=chromium`
  for design-system token changes.
- Focused Playwright or core tests for the behavior being documented.
- `git diff --check`
