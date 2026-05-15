# Lin Design System

This directory is the design-system source of truth for Lin Outliner. It is
organized for implementation work: each module maps to a stable part of the
product UI and should be updated before UI refactors land.

[`index.html`](./index.html) is the browsable design-system site. It should
render layout states first, then inventory, component, surface, outliner, agent,
overlay, tag, and token specimens. It is not a separate product surface.

## Modules

- [Inventory](./inventory.md): current product UI map, source ownership, gaps,
  component candidates, and refactor phases.
- [Progress](./progress.md): current UI refactor stage, completed work,
  in-progress items, deferred work, and validation checklist.
- [Foundations](./foundations.md): canonical tokens, typography, color,
  elevation, motion, and accessibility.
- [Components](./components.md): reusable UI component contracts for buttons,
  tabs, panels, resize handles, tags, menus, dialogs, forms, outliner rows, and
  agent UI.
- [Surfaces](./surfaces.md): product surface rules for shell, workspace,
  outliner, editor, tags, fields, commands, overlays, and agent UI.
- [Patterns](./patterns.md): product intent, reference boundary, app shell,
  multi-panel canvas, responsive shell, and tag hover composition patterns.
- [Outliner System](./outliner.md): panel, breadcrumb, node types, row anatomy,
  tags, descriptions, fields, definition configuration, and outliner overlays.
- [Agent System](./agent.md): agent dock, turn model, process/tool-call
  behavior, composer behavior, and sider-agent reference boundary.
- [Implementation](./implementation.md): implementation rules, site contract,
  validation expectations, and current product gaps.

## Product Refactor Rule

When refactoring product UI, use this order:

1. Start with [Inventory](./inventory.md) to identify the product area, source
   files, existing behavior, and component boundary.
2. Check [Patterns](./patterns.md) to confirm the change fits Lin's product
   model and workflow behavior.
3. Use [Foundations](./foundations.md) tokens before adding one-off values.
4. Apply [Components](./components.md) and [Surfaces](./surfaces.md) to the
   specific UI being changed.
5. Validate against [Implementation](./implementation.md) before merging.

Do not treat site-only CSS as product source. Product code remains authoritative
for real behavior, while this design system defines the intended visual and
interaction contract.
