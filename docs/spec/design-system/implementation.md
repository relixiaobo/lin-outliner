# Implementation

## Product Implementation Rules

1. Prefer tokens over one-off pixel values.
2. Do not style fake preview panels as if they were real product outliners.
3. Do not add reference-app features as a side effect of copying visual layout.
4. Keep shell state separate from document state.
5. Keep sidebar and agent visibility outside tab state.
6. Keep panel state inside the active workspace tab model.
7. Use real `NodePanel` for every product outliner panel.
8. Do not override outliner row typography from the shell.
9. Use icon aliases from `src/renderer/ui/icons.ts` for product UI controls.
10. Validate layout with screenshots at desktop widths before merging.
11. Validate at least one narrow desktop width where the agent or sidebar is
    collapsed.

## Design-System Site Contract

`index.html` is the browsable design-system site for humans reviewing the design
system.

The site should:

- Load without external network dependencies.
- Render app shell layout states first, as structural specimens rather than
  detailed product mockups.
- Provide browsable sections for inventory, component contracts, surface
  specimens, outliner, agent, overlays, tags, and foundations.
- Use the same token names and canonical values as this design system.
- Reuse real product class names and icon semantics wherever the preview maps to
  an implemented component.
- Treat static HTML icons and glyphs as semantic specimens only. Product icon
  shape, stroke, size, and alignment are defined by `src/renderer/ui/icons.ts`
  and the product components that render those aliases.
- Prefer an obviously abstract specimen icon block in the static site instead
  of hand-drawn approximations of Lucide icons. The site should communicate
  icon placement and hierarchy, not establish a second icon set.
- Show the source files behind each major preview surface so the design system
  remains tied to the implementation.
- Clearly label static sample content as preview content.
- Include token swatches only as supporting reference.

The site should not:

- Claim to be a real product surface.
- Invent alternate shell, sidebar, agent, or workspace component APIs when an
  implemented component already exists.
- Fill layout specimens with component detail that belongs in a component
  section.
- Use marketing-page hero composition as its first viewport.
- Use decorative card stacks to define product layout.
- Show controls that imply unavailable product behavior without a disabled or
  preview-only treatment.
- Introduce a second icon system or hand-drawn icon standard that diverges from
  `src/renderer/ui/icons.ts`.

## Source Map

Core UI surfaces should map back to these files:

- App shell: `src/renderer/ui/App.tsx`
- Top chrome: `src/renderer/ui/TopBar.tsx`
- Sidebar dock: `src/renderer/ui/Sidebar.tsx`
- Workspace canvas: `src/renderer/ui/WorkspaceCanvas.tsx`
- Outliner panel: `src/renderer/ui/NodePanel.tsx`
- Agent dock: `src/renderer/ui/AgentDock.tsx`
- Agent chat panel: `src/renderer/ui/agent/AgentChatPanel.tsx`
- Icon aliases: `src/renderer/ui/icons.ts`
- CSS tokens and layout classes: `src/renderer/styles.css`
- Outliner row, field, tag, and metadata classes:
  `src/renderer/styles/outliner.css`

## Stylesheet Boundaries

- `src/renderer/styles.css` owns foundation tokens, app shell, panel chrome,
  agent surfaces, shared overlays, command palette, and global feedback.
- `src/renderer/styles/outliner.css` owns outliner body rhythm: rows, leading
  markers, field rows, definition configuration, descriptions, applied tags,
  outliner context menus, batch tag selector, and children indentation.
- Shell styles may compose outliner components through more specific selectors
  such as panel title overrides, but must not redefine base row typography,
  row grid, or marker geometry.
- Outliner CSS may consume global tokens from `styles.css`, but should not
  introduce shell layout rules.

## Current Product Convergence Work

The full UI refactor should converge product code, design-system docs, and the
browsable site by:

- Moving repeated CSS values into canonical design tokens when they express a
  system decision.
- Keeping the real tab state model authoritative for panel state.
- Keeping the current outliner row interaction model authoritative for
  selection, editing, paste, drag/drop, triggers, collapse, and IME behavior.
- Keeping the current agent runtime model authoritative for sessions, turns,
  streaming, tools, settings, and restore behavior.
- Keeping panel, sidebar, and agent resize handles keyboard reachable as well
  as pointer reachable.
- Adding screenshot validation at desktop and narrow desktop widths.
- Continuing shared overlay convergence: `useAnchoredOverlay` owns positioning,
  viewport clamp, flip, scroll, and resize reflow; callers still need final
  Escape/outside dismissal and focus-restoration review.
- Finishing outliner heading, row, field, tag, and definition configuration
  visual convergence.
- Finishing agent message, process, tool-call, composer, settings, approval,
  and debug visual convergence.
- Keeping `docs/spec/design-system/index.html` synchronized with real product
  source maps instead of maintaining a separate demo style.
