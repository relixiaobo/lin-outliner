# File presentation redesign

How a file is shown and opened across the app, unified into one coherent story.
This is **shape (a): one complete feature in one PR**, with internal build-order
A → B → C (A7 foundation-before-consumers). The three parts are build stages of
one feature, not separate releases.

## Goal

Optimize how files appear and open in two contexts:

1. **Outliner file nodes (non-image)** stop rendering as a heavy block card and
   become a lightweight row: a **file-type icon as the bullet** + the **filename
   as the row's read-only content text**, single-click selects (never edits),
   like a reference row. The chevron **expands to an inline preview widget**; the
   node page shows the **same** widget. Previewable → widget renders the preview,
   primary action `Expand / Collapse`, `⋯` = Show in Finder / Open with default
   app. Not previewable → basic info, primary action `Open with default app`.
2. **The preview widget itself is simplified**: vertical scroll through pages, no
   page-number bar (`< 1/3 >`) and no zoom controls (`- 100% +`). One bottom-center
   floating pill = primary button + `⋯`.
3. **Agent-transcript file chips** open with the OS default app on click (not the
   in-app preview), and support a right-click menu: Add to Today / Open with
   default app / Show in Finder.

## Non-goals

- Images-as-row: images keep rendering inline as the real image (`FileNodeImage`).
- A node-level provenance/source field. The agent-vs-outliner split is **by
  location** (transcript chip vs outliner node), confirmed with the PM, so no
  `types.ts` protocol change. A file that becomes an outliner node always gets the
  rich preview regardless of origin.
- `file-preview` PR3/4/5 scope (media streaming / Office / URL reader) and the
  file-node data model are untouched.

## Design

### Decisions (ratified)

- PDF renders **all pages stacked vertically, lazily** (render on scroll via
  IntersectionObserver), replacing the single-page + page-nav + zoom model.
- **Add to Today** = create a file node under today's daily note pointing at the
  agent file (reuse the existing preview→outline ingest, retargeted to the date
  node), not a move/reference.
- Agent-vs-outliner is **by location** (no provenance field).

### Stage A — Preview widget simplification + floating control (shared)

The widget is shared by the node page and the inline-outliner host, so it changes
once here.

- **Strip the PDF toolbar.** `previewRenderers.tsx` `PdfPreview` (`:338-442`)
  currently renders `file-preview-pdf-toolbar` (page-nav `:397-417`, zoom
  `:419-437`) and a single `PdfPageCanvas` (`:444-513`). Replace with a scroll
  container that renders **every page** as a `PdfPageCanvas`, each lazily mounted
  when it scrolls near the viewport (IntersectionObserver), at a fixed
  fit-to-width scale (no zoom). Drop `pageNumber`/`scale` state, the zoom
  constants (`:74-77`), `clampPdfScale` (`:716-718`), and the now-unused
  `ChevronLeft/Right`, `ZoomIn/Out` imports + their i18n keys
  (`pdfToolbar`/`pdfPage`/`pdfZoom`/`pdfPreviousPage`/`pdfNextPage`/`pdfZoomIn`/
  `pdfZoomOut`).
- **Floating pill replaces the top toolbar.** `FilePreviewShell`
  (`previewRenderers.tsx:129-158`) renders `.file-node-toolbar` (meta + action
  icons) above `.file-node-preview`. Replace that top strip with a bottom-center
  floating pill overlaying the preview: a **primary button** + a **`⋯` menu**.
  The pill reuses the `MenuSurface` + `useAnchoredOverlay` + `useDismissibleOverlay`
  stack already used by `FileNodeActionMenu` (`FileNodeActionMenu.tsx`).
- **Expand / Collapse is a host height state.** The widget has a collapsed
  (peek) height and an expanded (full vertical-scroll) height. The primary pill
  button toggles it (`Expand` ↔ `Collapse`). Default: **collapsed/peek** when
  hosted inline in an outliner row, **expanded** on a dedicated node page. Lift
  this state into a small `FilePreviewWidget` wrapper that both hosts mount; pass
  an `initialExpanded` + host className.
- **Previewable vs not.** `PreviewRenderer` already falls back to
  `MetadataPreview` (`:103,515-541`) for unsupported types — that is the
  "cannot preview → basic info" branch. When the resolved renderer is the
  metadata fallback, the pill's **primary** action becomes `Open with default
  app` instead of `Expand`. Detect via the matcher (the `metadata` entry id).
- **`⋯` menu actions.** Show in Finder / Open with default app / Copy. For an
  asset source these already exist (`fileNodeAssetActions` → `api.openAsset` /
  `revealAsset` / `copyAssetFile`). For a local-file source, add a
  `revealPreviewSource(source)` helper mirroring `openPreviewSource`
  (`:740-752`): asset → `revealAsset`, local-file → `revealLocalFile` (new seam,
  below). The meta string (`PDF · 4.9 KB · 3 pages`) moves off the top bar; keep
  it as a quiet caption inside the `⋯` menu header (or drop — decided in build).

### Stage B — Outliner file row redesign + inline expand

The single-click-selects-not-edits behavior already exists (`OutlinerItem.tsx`
`fileNodeRow` branch `:1544-1554`). Changes:

- **File-icon bullet.** Add a `'file'` `RowMarkerVariant` (`RowMarker.tsx:8`)
  that renders the file-type glyph (`INLINE_FILE_ICON_CLASS` +
  `data-file-icon-kind={fileNodeIconKind(node)}`) instead of `NodeBulletDot`.
  Thread the icon kind through `RowLeading` → `RowMarker`. Set `leadingVariant`
  to `'file'` for `fileNodeRow` (`OutlinerItem.tsx:350-360`, update the comment
  there). Honor B6 — no box/`--fill-*`; color-only.
- **Filename in the content area.** Replace the `FileNodeCard` block
  (`OutlinerItem.tsx:1897-1901`, `FileNodeCard.tsx`) with the filename rendered
  as the row's read-only content text (a `.file-node-row-name` span where the
  editor would sit), keeping the existing `FileNodeKeyboardAnchor`
  (`:1903-1921`) for keyboard parity. The `⋯` actions move to a hover affordance
  on the row (reuse `FileNodeActionMenu`, or the shared pill on the inline
  widget). `FileNodeImage` is unchanged. `FileNodeCard` is removed once unused.
- **Chevron → inline preview.** When a `fileNodeRow` is expanded (`row.expanded`),
  render the shared `FilePreviewWidget` (collapsed/peek default) as part of the
  file row's own output, below `.row-content-line`, inside `OutlinerRowShell`.
  Any real child nodes still render as normal flat rows after it (mirrors the node
  page: preview hero, then children). Verify the `OutlinerRowShell` layout hosts a
  below-the-line block; confirm the flat/windowed renderer measures the taller row.
- **Node page** (`NodePanel`/`FilePreviewPanel`/`FilePreviewBody`) hosts the same
  `FilePreviewWidget` (expanded default), and its top action strip
  (`FilePreviewPanel.tsx:155-168,261-266`) collapses into the widget's floating
  pill.

### Stage C — Agent-transcript file: external open + right-click + Add to Today

Scope strictly to transcript chips (`AgentMarkdown` deliverable links +
`file_write`/`file_edit` result chips); the outliner inline file-ref behavior is
unchanged.

- **Click opens externally.** The app-wide `InlineFilePreviewLayer.handleClick`
  (`:146-170`) currently `dispatchPreviewTargetOpen` → in-app pane. For a chip
  rendered inside the agent transcript, route the click to `window.lin.openLocalFile`
  (or `revealLocalFile` per menu) instead. Distinguish transcript chips by a
  container/data attribute on the agent markdown render root, not a node field.
- **Right-click menu.** Add a context menu on transcript file chips: Add to Today
  / Open with default app / Show in Finder. Build it on the same overlay
  primitives (`MenuSurface` + `useAnchoredOverlay`) used elsewhere, or the native
  Electron menu path already used for agent messages (`main.ts:1240-1279`) —
  decided in build; prefer the renderer overlay for consistency.
- **Add to Today.** `ensureDateNode` for today (`core.ts:303 todayId`, `:2066
  ensureDateNode`, command `ensure_date_node` `commands.ts:86`), then create a
  file node under it pointing at the file. Reuse the existing preview→outline
  ingest (`previewIngest.ts requestAddPreviewTargetToOutline`), retargeted to the
  date node instead of the active panel.

### Stage 0 — Shared seam (foundation, lands first)

Only "Show in Finder by path" is missing today (`reveal_asset` is asset-id only,
`main.ts:1712`). Add:

- `main.ts`: `ipcMain.handle('lin:reveal-local-file', …)` → `shell.showItemInFolder`
  with the same path validation as `lin:open-local-file` (`:1590-1595`).
- `preload/index.ts`: `revealLocalFile(options)` mirroring `openLocalFile`
  (`:364-365`).
- A renderer wrapper + `revealPreviewSource(source)` helper in
  `previewRenderers.tsx`.

## Open questions

All ratified by the PM:

- PDF zoom removed; vertical scroll + fit-to-width only — **yes**.
- Add to Today = new file node under today's daily note — **yes**.
- Build all three together, cleanest, parallel allowed — **yes** (Stage C is
  built in parallel in a worktree; A/B by the lead).

## Checklists

- [ ] Stage 0: `lin:reveal-local-file` IPC + preload + `revealPreviewSource`
- [ ] Stage A: strip PDF toolbar; lazy vertical pages; floating pill; collapse
      state; previewable-vs-not primary action
- [ ] Stage B: `'file'` bullet variant; filename-in-content row; inline expand
      preview; node-page widget; remove `FileNodeCard`
- [ ] Stage C: transcript-chip external open; right-click menu; Add to Today
- [ ] i18n en/zh; typecheck; `test:core` / `test:renderer`; relevant e2e;
      light+dark visual; `docs:check`
- [ ] Fold design into `docs/spec/file-preview*` / `file-as-node` /
      `agent-event-log-rendering`; CHANGELOG (main-owned)
