# Field Value Nodes Support Ordinary Children

## Goal

Make every stored field value behave like an ordinary outliner node for local
structure: it can expand, expose an empty child draft, contain child rows, and
participate in Tab / Shift+Tab indentation without losing focus.

The structural boundary stays explicit:

- A `fieldEntry` remains a non-expandable value container.
- The `fieldEntry`'s direct children are the field's stored values.
- Descendants below a stored value are ordinary outline children, not additional
  values of the field.
- Outdenting an ordinary child directly under the `fieldEntry` promotes it into
  a stored field value.

This plan is shape (a): one complete user-visible feature in one PR.

## Non-goals

- Do not change the core node schema, command protocol, field cardinality, field
  resolution, or persistence format.
- Do not make computed system-field values mutable.
- Do not make the `fieldEntry` row itself expandable.
- Do not allow a direct field value to Shift+Tab out of its owning `fieldEntry`.
- Do not add cross-field drag/drop or arbitrary move-to behavior for direct field
  values.
- Do not change how option values, reference values, dates, validation, or field
  value cleanup are created and stored.

## Design

### Structural Semantics

Keep `fieldEntry.children` as the canonical value list. A direct stored value
retains field-aware editing and deletion semantics. Its own children render in a
nested ordinary `OutlinerView`, without forwarding the field-value context, so
all deeper rows use normal node commands.

This gives each level one unambiguous meaning:

```text
fieldEntry
  value A               stored field value
    child A.1            ordinary child node
      nested field       ordinary field row under value A
  value B               stored field value
```

Field reads, validation, sorting, filtering, option cleanup, and serialization
continue to inspect only the direct children of the `fieldEntry`. Descendants
remain part of the value node's subtree but are not interpreted as additional
field values.

### Disclosure And Child Creation

Remove the field-value-only suppression of nested row rendering. A stored value
uses the same disclosure behavior as an ordinary row:

- Hover or keyboard focus reveals its chevron without changing layout.
- Clicking a leaf chevron expands an empty child scope and focuses its trailing
  draft.
- Clicking a populated value chevron toggles its children.
- Expanded values render normal child rows, trailing drafts, and indent guides.
- Reference values expand through the existing reference target projection and
  preserve the existing cycle guard.
- An empty checkbox field keeps its standalone toggle because no value node exists
  yet. Once toggled, the stored boolean renders through the same expandable value
  row as other types, with the checkbox control replacing editable text while
  preserving the row's structural navigation and selection keys.
- Arrow navigation uses the panel's visible selectable-row order, so it crosses
  field boundaries. It never mounts an auto-hidden field-value draft; only an
  already visible expanded-child draft or panel trailing draft participates.
  ArrowDown from an expanded-child draft resumes at the first visible row after
  that draft's structural position instead of falling through to the panel end.

The value column keeps its dense field layout, but it must reserve a real,
stable disclosure slot. Nested field-entry rows continue to hide their own
field-entry chevron because a field entry's direct children are its values.

### Editing Keyboard

Remove the blanket `fieldValue` early return in the row Tab handler and use the
existing structural boundary checks:

- Tab on a direct value indents it under its previous direct sibling and expands
  that sibling. The first direct value remains a no-op.
- Shift+Tab on a direct value is a no-op because the field entry is that nested
  render scope's root.
- Tab and Shift+Tab on descendants use normal outliner behavior.
- Shift+Tab on a child whose parent is a direct value moves it into the
  `fieldEntry`, promoting it to a direct stored value.
- Cursor placement and edit focus survive every move through the existing focus
  request path.

### Selection Keyboard And Movement Policy

Selected direct field values should support batch Tab indentation when their
selected run has a valid unselected previous sibling. They must still be blocked
from batch Shift+Tab at the field boundary and from arbitrary move-to / drag
reparenting.

Split the current shared structural filter so keyboard indentation and external
move targets do not share one overly broad policy:

- Batch indent may include mutable direct field values.
- Batch outdent excludes direct field values, while ordinary descendants remain
  eligible subject to the panel-root boundary.
- Drag/move-to continues to exclude direct field values.
- Sibling move up/down remains unchanged.

### Delete And Field Cleanup

A direct field value keeps `removeFieldValue` semantics, including collected
option cleanup and subtree removal. A descendant row is rendered without the
field-value context and therefore uses ordinary node deletion semantics.

An empty direct value with children remains protected by the existing
"do not delete a subtree from Backspace" rule. Selection deletion of a direct
value intentionally removes the value subtree through `removeFieldValue`.

### Specs And Tests

Resolve the current specification contradiction by documenting the distinction
between a field entry, its direct values, and descendants below each value.

Renderer tests cover:

- selectable ordering through expanded value descendants;
- direct value batch-indent eligibility;
- direct value batch-outdent and move-to rejection;
- ordinary descendant structural eligibility.

Playwright coverage verifies:

- leaf disclosure creates and focuses a child draft;
- a second direct value Tabs under the first and remains visible;
- collapsing and re-expanding preserves the child;
- Shift+Tab promotes the child back to a direct value;
- Shift+Tab on a direct value is a no-op;
- field-entry chevrons and computed system values remain unchanged;
- reference values can expand while reference cycles remain bounded.
- ArrowDown from an empty value-child draft focuses the following visible field
  rather than the panel trailing draft.

Light and dark screenshots verify value-column alignment, disclosure geometry,
indent guides, wrapping, focus, and hover without overlap or layout shift.

## Risks

- Restoring the disclosure slot can shift the dense value-column text axis. CSS
  must use stable grid dimensions and update the visual parity guard deliberately.
- Nested rows live inside the field row while the outer panel uses the flat
  renderer. Row measurement, selection order, and focus propagation must remain
  correct when the field row height changes.
- Direct values and descendants intentionally have different delete semantics;
  accidentally forwarding the field-value context would corrupt field cleanup.
- Reference values project a target subtree rather than their stored reference
  node's empty child list, so expansion must keep the existing cycle guard.

## Collision Result

- `docs/TASKS.md` contains no active field-value disclosure or indentation task.
- Draft PR #393 (`codex-4/remove-reference-field-type`) plans to touch field-value
  UI, specs, and focused tests while removing the protocol-level `reference`
  field type. It currently contains only its plan and is blocked on PR #392.
- This feature does not touch `src/core/types.ts`, `src/core/commands.ts`, or the
  dedicated reference-field command path. Recommended order: land this renderer
  structure feature first, then rebase #393 so its removal preserves the new
  ordinary-node behavior.
- The Draft PR for this plan records the overlap so merge sequencing is visible
  without using the PM as a message bus.

## Open Questions

None. The approved direction is that stored field values are ordinary nodes
below the direct-value boundary, while the field entry remains the container.

## Validation Checklist

- [ ] Typecheck passes.
- [ ] Renderer tests pass.
- [ ] Focused outliner Playwright tests pass.
- [ ] Full relevant outliner E2E coverage passes.
- [ ] Documentation checks pass.
- [ ] Light and dark visual verification passes.
- [ ] Draft PR scope and #393 overlap are recorded before implementation.
