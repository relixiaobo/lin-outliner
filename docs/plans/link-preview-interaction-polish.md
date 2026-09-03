# Link And Preview Interaction Polish

## Goal

Make pasted links, Source preview defaults, attachment selection, and saved-search
view controls communicate their behavior consistently. This is ONE complete
user-visible feature in one PR; the implementation steps do not ship separately.

## Non-goals

- No webpage metadata ingestion, authored-title replacement, static Reader mode,
  new preview target, or new persistence/protocol surface.
- No change to ordinary inline-link paste, typed URLs, Source ordering, child
  disclosure, Table projection, or file-preview renderer coverage.
- No redesign of the complete view-configuration toolbar.

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

### Saved-search view mode control

The compact Outline/Table control remains one visible two-option segmented
control. Its pill track and neutral selected segment make the grouping and active
mode legible without adding text to the dense result band. Hover/focus tooltips
anchor below their individual controls and never cover a sibling control. The
same component remains present in Outline and Table modes and keeps its current
accessible names and pressed states.

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
- The compact Outline/Table selector has one visible pill track, one neutral
  selected segment, and a tooltip that does not intersect either mode button.
- Narrow layouts keep every mode segment intact and wrap toolbar controls only as
  complete units; light, dark, keyboard, pointer, reduced-motion, and
  reduced-transparency behavior remain valid.

## Verification

- Renderer tests cover linked bare-URL content and derived/explicit preview
  visibility.
- Playwright covers generic URL, YouTube, attachment selection, cursor behavior,
  and Outline/Table geometry in wide and narrow layouts.
- Visual screenshots cover the affected surfaces in light and dark appearances.
- Run `bun run typecheck`, `bun run test:renderer`, the relevant Playwright specs,
  `bun run docs:check`, and `git diff --check`.

## Files And Collision Boundary

Expected implementation files are `src/renderer/api/outlineIntents.ts`,
`src/renderer/ui/outliner/OutlinerItem.tsx`, `OutlinerRowShell.tsx`,
`ViewToolbar.tsx`, `src/renderer/ui/preview/NodeSourcesSection.tsx`,
`nodeSources.ts`, `sourceViewState.ts`, outliner/preview styles, focused renderer
and Playwright tests, `docs/spec/ui-behavior.md`, and
`docs/spec/design-system/surfaces.md`.

Open PRs #619 and #620 do not overlap this renderer UI or specification surface.
The plan does share preview-shell files with `url-static-reader`,
`file-preview-office`, and preview units in `interaction-jank-cleanups`; this
Draft PR claims that lane until merge or close.

## Risks

- Link activation inside a contenteditable title can regress caret behavior;
  scope the link to generated URL content and preserve existing RichText rules.
- A global `previewVisible = false` default would regress files and media; derive
  the initial value from the selected Source and keep explicit state authoritative.
- Extending selection through child field rows would misrepresent document
  selection; constrain the composite frame to the preview and owner row.
- Tooltip placement can escape short panes; reuse the shared anchored-overlay
  bounds rather than fixed coordinates.

## Open questions

None.
