# Link And Preview Interaction Polish

## Goal

Make pasted links, Source preview defaults, attachment selection, saved-search
view controls, and structural editing focus communicate their behavior
consistently. This is ONE complete user-visible feature in one PR; the
implementation steps do not ship separately.

## Non-goals

- No webpage metadata ingestion, authored-title replacement, static Reader mode,
  new preview target, or new persistence/protocol surface.
- No change to ordinary inline-link paste, typed URLs, Source ordering, child
  disclosure, Table projection, or file-preview renderer coverage.
- No new view-configuration capability or persisted view node shape.

## Design

### Pasted URL identity and activation

An exact bare URL pasted into an empty ordinary Node continues to create one
Source-backed Node atomically, but the generated URL content carries a link mark
to the same normalized URL. It therefore uses the established native-blue link
presentation, hand cursor, and click route into a Tenon split preview. Ordinary
RichText editing remains authoritative: replacing the generated content may
remove or change the link just like any authored link.

All outliner content anchors use the same explicit hover cursor and link styling.
Editable-container inheritance must not make a genuine link report a text cursor.

### Preview default policy

Preview visibility remains renderer-local and explicitly user-controlled. When
an owner has no recorded visibility choice, strong previews start visible:
managed assets, linked files, and recognized YouTube URLs. Generic `http(s)`
webpages start hidden. Showing or hiding a Source records the user's choice;
adding or editing values preserves it. Existing recorded choices win over the
new derived default.

### Composite selection

When an ordinary Source-backed owner with a visible preview is selected, one
neutral selection frame spans the preview and owner title/content composition.
The Source field remains an ordinary child field row outside that owner frame.
The frame uses existing selection tokens, does not tint interactive media, does
not intercept input, and does not alter layout.

### View toolbar identity

`ViewToolbar` owns its presentation and capability decisions. Renderers provide
the owner and view state but cannot select an independent toolbar variant.
Every Node therefore uses the same full bar, control order, labels, Filter chips,
and interactions across Outline and Table. The bar has no frame or decorative
separators. Display, Group, Sort, and Filter express configured state on their
own controls through `--control-on` icon color without a background; the neutral
fill is reserved for an open popover. Individual Filter rule chips remain beside
Filter as editable objects, summarize their effective conditions, and stay with
it on the toolbar's single horizontally scrollable line. The Outline/Table control remains one
visible two-option segmented control whose pill track and neutral selected
segment make the grouping and active mode legible. Node type affects only the
unset visibility default: Search starts open and ordinary Nodes start closed.
An explicit `viewDef.toolbarVisible` value wins in both directions, so every Node
can use the same Show/Hide action.

Display placement distinguishes the two existing surfaces without adding a new
state model. A field explicitly added from Outline uses `title`; fields defaulted
or added while the owner is in Table use `body`. Table columns consume all
visible display fields, while Outline title metadata consumes only `title` and
legacy unspecified placements. Selecting a Table-only field from Outline's
Display menu promotes it to `title`. Switching view mode therefore does not make
Table column defaults appear like Node description content.

Node disclosure uses the complete visible child scope, including field entries.
Content insertion keeps a separate content-only child scope so Enter placement
never targets a field entry. Source preview remains outside both scopes and
therefore independent of disclosure.

Table Title and field headers reuse the row leading grid instead of maintaining
separate padding. A reserved chevron slot precedes each kind icon, aligning
header icons with row bullets and header labels with row text at every column
width.

### Structural editing focus

Tab and Shift+Tab relocation keep the same row in text-editing mode through both
the optimistic move and authoritative projection settlement. The renderer
re-issues the existing row focus request only when focus has fallen to the
document body and UI focus ownership still names that row, parent, panel, and
surface. A newer pointer or keyboard focus owner therefore wins, while an
unclaimed Electron/DOM focus loss self-heals without a direct DOM focus shortcut.

## Acceptance Criteria

- A bare generic webpage URL pasted into an empty Node creates one linked-title
  Source-backed Node whose inline preview starts hidden.
- A recognized YouTube URL and a managed or linked file still start with their
  strong preview visible when no user visibility choice exists.
- Clicking the generated URL title follows the existing Tenon URL-preview route;
  hovering that title reports a pointer cursor while adjacent editable text
  reports a text cursor.
- Explicit Show/Hide state survives ordinary re-renders and takes precedence
  over the source-kind default.
- Selecting a preview-bearing owner paints one stable neutral frame across its
  preview and title/content without covering its Source field or changing media
  hit testing.
- Every Node toolbar keeps one full-bar structure, control order, labels,
  Filter rule chips, and interaction model across Outline and Table.
- Table-defaulted and Table-added columns do not render as Outline title metadata;
  an explicit Outline Display selection does.
- A Node whose only children are field entries exposes the parent marker and
  disclosure state, while content insertion remains ordered after field entries.
- The Outline/Table selector has one visible pill track and one neutral selected
  segment.
- The context-menu **View as** entry opens a side submenu on hover, click, or
  `ArrowRight` without pointer hover stealing keyboard focus.
- Table Title and field header icons align with row bullets, labels align with
  row text, and a stable chevron slot precedes both.
- Tab and Shift+Tab preserve the editing caret through optimistic relocation,
  text-patch settlement, and authoritative projection reconciliation; a focus
  that moved to another control is never reclaimed.
- Narrow layouts keep every mode segment intact and keep toolbar controls on one
  horizontally scrollable line; light, dark, keyboard, pointer, reduced-motion, and
  reduced-transparency behavior remain valid.

## Verification

- Renderer tests cover linked bare-URL content and derived/explicit preview
  visibility.
- Playwright covers generic URL, YouTube, attachment selection, cursor behavior,
  Outline/Table geometry in wide and narrow layouts, and Tab/Shift+Tab focus
  continuity across structural settlement.
- Visual screenshots cover the affected surfaces in light and dark appearances.
- Run `bun run typecheck`, `bun run test:renderer`, the relevant Playwright specs,
  `bun run docs:check`, and `git diff --check`.

## Files And Collision Boundary

Expected implementation files are `src/renderer/api/outlineIntents.ts`,
`src/renderer/ui/focus/focusRequestDom.ts`, shared editor/control focus
consumers, `src/renderer/ui/outliner/OutlinerItem.tsx`,
`optimisticStructuralEdit.ts`,
`OutlinerTableView.tsx`, `ViewToolbar.tsx`,
`src/renderer/ui/preview/NodeSourcesSection.tsx`,
`nodeSources.ts`, `sourceViewState.ts`, outliner/preview styles, focused renderer
and Playwright tests including `outliner-row-editing.spec.ts`,
`docs/spec/ui-behavior.md`, and
`docs/spec/design-system/surfaces.md`.

## Risks

- Link activation inside a contenteditable title can regress caret behavior;
  scope the link to generated URL content and preserve existing RichText rules.
- A global `previewVisible = false` default would regress files and media; derive
  the initial value from the selected Source and keep explicit state authoritative.
- Extending selection through child field rows would misrepresent document
  selection; constrain the composite frame to the preview and owner row.
- Tooltip placement can escape short panes; reuse the shared anchored-overlay
  bounds rather than fixed coordinates.
- A delayed focus repair could steal focus after the user moves elsewhere;
  require both an unclaimed document-body focus and unchanged row-level UI focus
  ownership before re-issuing the request.

## Open questions

None.
