# Product Specification Map

`docs/spec/` defines current intended behavior. Product code is executable
authority; a behavior change updates its owning spec in the same PR.

Forward-looking design belongs in `docs/plans/`. Shipped design is folded here
and its plan is archived by the integration gate.

## Agent System

Read these in order when changing Agent Core:

1. [`agent-core.md`](agent-core.md)
2. [`agent-thread-rendering.md`](agent-thread-rendering.md)
3. [`agent-subagent-threads.md`](agent-subagent-threads.md)
4. [`agent-model-runtime.md`](agent-model-runtime.md)
5. [`agent-tool-design.md`](agent-tool-design.md)
6. [`agent-tool-permissions.md`](agent-tool-permissions.md)
7. [`agent-skills.md`](agent-skills.md)
8. [`agent-integration.md`](agent-integration.md)

| File | Owns |
| --- | --- |
| `agent-core.md` | Thread, Turn, Item, Goal, lifecycle, provenance, storage, transport, extensions, and trusted document transactions. |
| `agent-thread-rendering.md` | Canonical DTO rendering, dock state, pagination, interaction states, and visual behavior. |
| `agent-subagent-threads.md` | Child Thread lineage, Roles, capability ceilings, collaboration tools, and fork distinction. |
| `agent-model-runtime.md` | Provider execution, stream normalization, Item recording, steering, cancellation, and compaction. |
| `agent-tool-design.md` | Canonical model-tool registry, catalog, schemas, results, execution, and audit. |
| `agent-tool-permissions.md` | Full Access, explicit blocks, native failures, capability selection, and capability audit. |
| `agent-skills.md` | Skill discovery, identity, invocation, isolation, restore, authoring, and settings. |
| `agent-integration.md` | Cross-layer integration and verification contracts for Agent capabilities. |

## Document And Outliner

| File | Owns |
| --- | --- |
| [`architecture.md`](architecture.md) | Electron process boundaries, document ownership, persistence, and security posture. |
| [`commands.md`](commands.md) | Document command surface and mutation routing. |
| [`ui-behavior.md`](ui-behavior.md) | Outliner editing, selection, navigation, drag, menus, and interaction rules. |
| [`outliner-parity-matrix.md`](outliner-parity-matrix.md) | Detailed parity evidence for outliner behavior. |
| [`workspace-layout.md`](workspace-layout.md) | Workspace panes, navigation history, rails, and layout persistence. |
| [`date-field-values.md`](date-field-values.md) | Date field parsing, storage, editing, display, and query semantics. |
| [`search-query-grammar.md`](search-query-grammar.md) | Structured Node search grammar and evaluation. |
| [`launcher.md`](launcher.md) | Global launcher, capture, search, and launcher IPC. |

## Platform

| File | Owns |
| --- | --- |
| [`design-system.md`](design-system.md) | Visual system kernel and links to detailed design layers. |
| [`error-observability.md`](error-observability.md) | Error reporting, diagnostic storage, redaction, and export. |
| [`i18n.md`](i18n.md) | Typed messages, locale selection, persistence, and native-menu refresh. |

The detailed design-system layers live under `design-system/` and are routed by
[`design-system.md`](design-system.md).

## Ownership Rules

- One document answers one question; link instead of duplicating a contract.
- Keep protocol, code, tests, and specs synchronized.
- Put current behavior here and future behavior in plans.
- Delete or merge obsolete authorities; do not keep redirect stubs.
- Keep `docs/TASKS.md` as the only work-status catalog.

## Validation

Run the checks required by the changed surface, then always run:

- `bun run typecheck`
- relevant Core, renderer, and E2E tests
- `bun run docs:check`
- `git diff --check`
