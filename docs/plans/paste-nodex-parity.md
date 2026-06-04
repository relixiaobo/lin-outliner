---
status: in-progress
priority: medium
owner: relixiaobo
created: 2026-06-04
updated: 2026-06-04
---

# Paste: nodex parity

Bring clipboard paste up to nodex's level on two surfaces the PM flagged:
the agent composer (multi-line) and the outliner (format conversion depth).

## Goal

- **Agent composer**: pasting multi-line text inserts every line, not just the
  first. *(Shipped separately on `cc/composer-multiline-paste`.)*
- **Outliner**: close the gaps where the existing structure-aware paste
  (`pasteParser.ts`, shipped in `3a7ea00`) still collapses or under-converts
  real-world clipboard content, and add nodex's `#tag` / `field:: value`
  metadata extraction.

## Non-goals

- Web-clip / page-capture pipelines (separate plan).
- Tana import (`nodex-parity-decisions.md` keeps this skipped).
- HTML-path `#tag` / `field::` extraction — metadata extraction is scoped to the
  plain-text / Markdown path (the dominant source for that syntax). HTML pastes
  still convert structure, just without tag/field harvesting.

## Design

### A. Renderer-only robustness (`pasteParser.ts`)

1. **`<br>` as a node boundary.** Today `appendInline` turns `<br>` into a
   space, so `<div>a<br>b<br>c</div>` (Gmail / Apple Notes / many contenteditable
   sources) collapses into one node. Split a block's inline run at each `<br>`
   into sibling nodes, matching nodex `html-to-nodes.ts`.
2. **Special bullet glyphs.** Normalize `◦ ▪ ‣ · ●` (plus `-­ *• `) as list
   markers in `listText`.
3. **Google-Docs unwrap.** An inline wrapper (`<b style="font-weight:normal">`)
   whose children are block elements is recursed into rather than flattened.
4. **Markdown-over-flat-HTML routing.** A pasted outline often arrives as raw
   Markdown in text/plain AND flat `<div>`-per-line text/html (editor copy). The
   HTML whitespace-folds the indentation away and never strips the `-`/`[x]`
   markers, so it pastes flat with literal `- `. `looksLikeStrongMarkdown` now
   also fires on a multi-line bullet/task/numbered list, so the faithful
   text/plain parser wins. (This was the live bug in the PM's paste test.)
   **But** the text-plain preference applies only when the HTML is the lossy side
   — flat `<div>`/`<p>`. When the HTML carries real `<ul>/<ol>/<li>` structure
   (`htmlHasList`) it keeps both hierarchy and its inline marks, so it is trusted
   and a rich web-list paste does not lose its bold/links. (Review #3, 2026-06-04.)
5. **GFM task lists → checkboxes.** `- [x]` / `- [ ]` become checkbox rows.
   `lineToTree` strips the marker and sets `checkbox`/`done` on the tree;
   `CreateNodeTree` carries them; core maps them to the `completedAt` sentinel
   (`undefined` none, `0` unchecked, timestamp checked). When the first block
   **merges into an existing non-empty row**, the renderer suppresses
   `checkbox`/`done` so an existing line is never silently flipped to checked;
   only a genuinely empty target row adopts the pasted checkbox state. (PM
   decision, Review #2, 2026-06-04.)

### B. `#tag` / `field:: value` extraction (protocol + core)

The parser runs in the renderer and has no `DocumentState`, so it cannot resolve
names → ids. It therefore emits **names**; core does find-or-create. This mirrors
nodex's `ParsedPasteNode` carrying tags/fields and `applyParsedPasteMetadata`.

- **Parser** (`pasteParser.ts`): `extractTagsAndFields(text)` pulls trailing/inline
  `#tag` and `name:: value` tokens off a Markdown line, returning the cleaned text
  plus `tags: string[]` and `fields: {name,value}[]`. Conservative guards to avoid
  mangling code/URLs: tag = `(^|\s)#[A-Za-z][\w-]*`; field requires a double colon
  **followed by whitespace** (`name::␣value`) so `std::cout`, `http://…`,
  `foo::bar` never match. Applied in `lineToTree` (before `parseInlineMarkdown`
  so `#`/`::` don't perturb mark offsets). Link `[label](url)` and inline-code
  `` `code` `` spans are masked out of the scan, so a `#frag` or `name::` inside
  link text / a URL / code is left alone (`See [the #section](url)` keeps its
  label — Review #1, 2026-06-04).
- **Protocol** (`types.ts`): `CreateNodeTree` gains `tags?: string[]` and
  `fields?: ParsedPasteField[]` (`ParsedPasteField = {name; value}`).
- **Core** (`core.ts`): new `applyPasteMetadataDirect(nodeId, tags, fields)` —
  for each tag `findTagByName ?? createTagDefDirect` then `applyTagNoHistoryDirect`
  (reuses the capture path's pattern); for each field `findFieldDefByName ??
  insertFieldDefNodeDirect(SCHEMA_ID, name, 'plain')`, reuse a tag-template entry
  if present else `insertFieldEntryNodeDirect`, then set the value — an existing
  `options` field find-or-creates+selects the option (`ensureOptionNodeDirect` +
  `selectFieldOptionDirect`), every other type appends a plain content value
  child. Called from `insertNodeTreeDirect` (children + siblings) and
  `pasteNodesIntoNode` (the merged first row).
- **Wiring**: `pasteNodesIntoNode` gains `firstTags` / `firstFields`; threaded
  through `documentService.ts`, `api/client.ts`, the `onPasteOutliner` payload in
  `RichTextEditor.tsx`, and `handlePasteOutliner` in `OutlinerItem.tsx`.
  `create_nodes_from_tree` needs no signature change — the metadata rides on
  `CreateNodeTree`.

Per the PM decision (2026-06-04): **auto-create** tags and fields that don't
exist yet (nodex parity), reusing same-named defs and smart-selecting options on
existing `options` fields.

### C. Plain paste (`Cmd+Shift+V`)

Flatten to a single line into the current row (`RichTextEditor.tsx` paste
handler, gated by a keydown flag). Lowest priority; ship last.

## Open questions

- Duplicate field *values*: a pasted `field::` for a def whose entry a tag
  template already instantiated now fills that entry's existing empty value child
  instead of stacking a second one (`applyPasteMetadataDirect`, Review #4,
  2026-06-04). A reused entry that already holds a *non-empty* value still gets an
  appended value — acceptable for multi-value fields, revisit only if it surfaces.
- Tag/field syntax is recognized renderer-side (ASCII `#tag`) and diverges from
  `agentOutlineParser` (Unicode + brackets). Unification is tracked separately in
  `outline-syntax-unification.md` (Review #6).

## Review

Touches protocol/shared surface (`types.ts`, command signature) → `/code-review
ultra` at the gate. Unit (`pasteParser.test.ts`, `core.test.ts`) + e2e
(`outliner-paste-format.spec.ts`) cover each behavior.
