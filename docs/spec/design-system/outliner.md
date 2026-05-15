# Outliner System

This module defines Lin's future outliner design contract against the current
product implementation. Product behavior in `NodePanel`, `OutlinerItem`, field
rows, editor, tags, and trigger popovers remains authoritative; visual tokens
and applied tag styling follow this design system.

This module does not introduce a new outliner interaction model. The current
product interactions are the baseline; the design system records their
structure, states, and constraints so later UI work can preserve them.

## Source Boundary

Primary sources:

- `src/renderer/ui/NodePanel.tsx`
- `src/renderer/ui/panelBreadcrumb.ts`
- `src/renderer/ui/outliner/OutlinerView.tsx`
- `src/renderer/ui/outliner/OutlinerItem.tsx`
- `src/renderer/ui/outliner/OutlinerFieldRow.tsx`
- `src/renderer/ui/outliner/FieldValueRenderer.tsx`
- `src/renderer/ui/outliner/RowLeading.tsx`
- `src/renderer/ui/outliner/NodeDescription.tsx`
- `src/renderer/ui/tags/TagBar.tsx`
- `src/renderer/ui/definition/DefinitionConfigPanel.tsx`
- `src/renderer/ui/outliner/TriggerPopover.tsx`
- `src/renderer/ui/outliner/NodeContextMenu.tsx`

Static design-system specimens must map to these product concepts. They should
not invent a simplified outliner that cannot represent the real app. When a
static specimen cannot reproduce product behavior exactly, label it as a
structure map instead of presenting it as the product UI.

## Panel Contract

An outliner panel contains:

- Breadcrumb navigation.
- Heading area.
- Optional node icon.
- Optional title checkbox when done/check behavior is enabled.
- Title rich text editor.
- Optional title description.
- Dedicated title tag row.
- Title action buttons, including a More action that opens the same node action
  surface as the row context menu.
- Optional heading field rows.
- Optional definition configuration.
- Optional definition template label.
- Outliner body.
- Trailing input.
- Panel-level context menu.

Panel title and row content both use `RichTextEditor`, but title typography is
larger and panel-owned. Shell CSS must not override editor selection,
composition, or trigger behavior.

Heading area order:

1. Node icon row when an icon exists.
2. Title segment with optional checkbox and title text.
3. Description segment bound to the title.
4. Tag segment with More actions aligned to the right.
5. Field segment when heading fields exist.

## Visual Tokens

The design system site may simplify behavior, but outliner spacing, typography,
and color must use the outliner contract values:

- Panel title editor: `26px` font size, `36px` line height, `600` weight.
- Breadcrumb: `13px` font size, `20px` line height, muted secondary color.
- Row editor: `15px` font size, `24px` line height.
- Row minimum height: `26px`.
- Row radius: `5px`.
- Row padding: `1px 6px 1px 6px`.
- Leading cluster width: `42px`.
- Leading cluster columns: `15px 4px 15px 8px`.
- Selection background starts at `21px`, not at the text edge.
- Description: `13px` font size, `18px` line height, muted text color.
- Field row grid: `clamp(112px, 32%, 180px) minmax(0, 1fr)`.
- Future applied tags use the `AppliedTag` / tag token contract: `22px` fixed
  height, color `50` background, color `600` text/icon, stable measured width,
  and the gapped relative hover layout.
- Row applied tags render inline after row text. Title applied tags live in the
  dedicated heading tag segment, not after the title text.
- Row tags do not become a second-line chip strip during normal editing.

Future visual colors are:

- Text: `--text-main`.
- Muted text: `--text-sub`.
- Secondary muted text: `--text-muted`.
- Selected row fill: neutral row selected token, not the legacy green product
  primary.
- Theme accent: `#f43f5e`, used sparingly for brand/status and precise remove
  hover states.
- Tag definition marker: current tag color, defaulting to the theme accent when
  no user tag color is present.

The design-system site may expose outliner-specific CSS aliases such as
`--outliner-text`, `--outliner-muted`, `--outliner-row-selected`, and
`--outliner-row-leading-width`. These aliases must resolve back to the canonical
foundation tokens or to the numeric values in this module; they are not a second
palette.

## Breadcrumb

Breadcrumb is navigation, not decoration.

- Origin button opens the workspace root.
- Breadcrumb segments open ancestor nodes.
- Workspace/root ancestors are hidden.
- Long ancestry collapses to first visible ancestor plus the last two visible
  ancestors.
- Collapsed middle levels use an ellipsis marker.
- Breadcrumb text is muted and compact; it should not compete with the title.

## Node Types

Rows must distinguish product concepts, but the visible leading states should
stay minimal.

Primary visible node leading states:

- `bullet`: normal content node.
- `reference`: dashed bullet for tree references.
- `collapsed parent`: normal content node with child rows hidden; the bullet has
  a subtle outer shell.

Additional product concepts:

- `content`: normal editable node.
- `reference`: tree reference to another node; leading marker is dashed.
- `tagDef`: tag definition node; leading marker uses tag color and hash glyph.
- `fieldDef`: field definition node; leading marker uses field type icon.
- `fieldEntry`: inline field row; rendered by `OutlinerFieldRow`, not a normal
  content row.
- system roots: Today, Library/root, Schema, Trash, Search; panel title may show
  a root icon.

The design system must not reduce behavior to one generic row, but the primary
visual language remains compact. The leading slot communicates state while
keeping text start stable.

## Row Anatomy

Normal content row:

- Row wrapper.
- Stable leading cluster: chevron slot, gap, bullet/open slot, content gap.
- Optional done checkbox.
- Rich text editor.
- Inline applied tags.
- Optional description.
- Optional trigger popover.
- Optional context menu.
- Optional children and trailing input.

Trailing input is an empty row state. Its bullet uses the dimmed leading color
and its placeholder is `Type here or '/' for commands`.

Field entry row:

- Same row wrapper and leading cluster.
- `outliner-field-grid` with field name column and value column.
- Field name input.
- Field value renderer or child-count preview when expanded.
- Optional description.

Rows stay text-first. Selection, hover, focus, drag/drop, and indentation must
not shift the editor text start.

Done state has three visible forms: no checkbox renders only the row bullet;
unchecked renders the same measured checkbox slot as a neutral filled square;
checked keeps that square, switches it to `--semantic-success`, and adds a
white internal check glyph.

## Leading Cluster

`RowLeading` owns hierarchy and type affordance.

- Chevron slot is fixed width and appears on hover/focus or when interaction
  requires it.
- Bullet/open slot is fixed width.
- Content rows use a small dot.
- Collapsed parent rows may use a subtle filled bullet shape.
- Reference rows use a dashed marker.
- Tag definition rows use a colored circular marker with hash glyph.
- Field rows and field definitions use field type icons.
- Applied tag colors may tint content row bullets.

## Tags And Description

- Row applied tags render inline after node text.
- Title applied tags render in the heading tag segment below the title
  description and above heading field rows.
- Tags do not become detached cards or decorative chip strips during normal
  editing.
- Tag open/remove actions are real controls.
- Descriptions are muted metadata below the content line or title line.
- Description edit state uses an inline text area rhythm, not a modal.

## Fields And Definition Configuration

Field behavior is not generic form behavior.

- `fieldEntry` rows use a name/value grid.
- Field values and definition configuration share one dense row treatment:
  compact icon slot, field/config name, and value. Definition config should not
  look like a separate settings card, and field values should not use a looser
  visual style than definition config.
- Field value types include plain, options, options-from-tag, date, number,
  password, formula, user, URL, email, checkbox, boolean, and color.
- Options use `OptionsPicker`.
- Checkbox and boolean commit immediately.
- Date/color controls commit immediately or on field-specific control events.
- Text-like values commit on blur/keyboard flow.
- Invalid number values use semantic invalid styling without changing row
  layout.
- Expanded field rows with child rows show a value preview such as child count
  and focus into field children.

Definition configuration appears under tag/field definition panel roots:

- Rows are dense configuration rows, not cards.
- Type, option source, checkbox/done behavior, sort, filter, group, and view
  toolbar controls must preserve outliner rhythm.
- Definition template outliner is labeled separately and still uses real rows.

## Trigger And Overlay States

The outliner has multiple editor-driven overlays:

- Slash command menu.
- Tag selector.
- Reference selector.
- Field creation trigger.
- Node context menu.
- Options picker.
- Floating editor toolbar.

These overlays are anchored to editor or row state. They must preserve selection
semantics and keyboard navigation.

## Specimen Requirements

The design-system site should show:

- Panel title with breadcrumb, tags, description, and checkbox/root icon state.
- Content row, reference row, tag definition row, field definition row, field
  entry row, completed row, selected row, and expanded/collapsed parent row.
- Tag and description inline placement.
- Field value type examples.
- Definition configuration and view toolbar as dense rows.
- Trigger/menu examples as overlays, not as fake inline content.

Specimens may use abstract icon blocks, but product implementation must use the
real `icons.ts` aliases and current component behavior.
