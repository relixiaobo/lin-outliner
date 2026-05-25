---
status: done
priority: P2
owner: relixiaobo
created: 2026-05-25
updated: 2026-05-25
---

# Paste Format Support

Bring clipboard paste closer to nodex's structure-aware handling, but mapped
onto **lin's own format** — our `TextMarkKind` set and the `codeBlock` node
type — rather than copying nodex's node model.

The gap that motivated this: lin's rich-text format already supports seven
marks (`bold`, `italic`, `strike`, `code`, `highlight`, `headingMark`, `link`),
but the paste parser only emitted three (`bold`, `code`, `headingMark`) and
ignored HTML entirely. Paste under-used the format the rest of the app already
renders and round-trips.

## Shipped

- **Inline marks** (`parseInlineMarkdown`): `**bold**`, `*italic*`,
  `~~strike~~`, `==highlight==`, `` `code` `` and `[text](url)` map to the
  matching marks; links carry `attrs.href`. Bold (`**`) is matched before
  italic (`*`). Underscore variants (`_italic_`, `__bold__`) are intentionally
  excluded so snake_case identifiers survive a paste.
- **Fenced code → `codeBlock`** (`parseMarkdownBlocks`): a ` ``` `/`~~~` fence
  becomes a `codeBlock` row, preserving inner newlines and indentation; the
  fence language is normalized through the shared alias map
  (`ts` → `typescript`, …) so the picker shows the right option.
- **HTML routing** (`parseClipboardPaste` → `htmlToTrees`): when the clipboard
  has genuine HTML structure and the plain text is not strong markdown, a
  `DOMParser` walk maps headings (`h1`–`h6` → `headingMark`), lists (`ul`/`ol`
  with nesting → child rows), paragraphs, `<pre>` → `codeBlock`, tables
  (flattened to `a | b` rows) and inline tags (`strong`/`b`, `em`/`i`,
  `s`/`del`, `code`, `mark`, `a[href]`, plus a few inline `style` heuristics).
  Falls back to markdown parsing when no DOM is available (e.g. unit tests).
- **Single-line URL** (`detectSingleLineUrl`): a lone `https?://…` or `www.…`
  paste wraps the current selection as a link, or inserts a link-marked URL
  when the selection is empty. Bare domains (`example.com`) are deliberately
  not auto-linked to avoid false positives.
- **Core**: `CreateNodeTree` gained optional `type` / `codeLanguage`;
  `insertNodeTreeDirect` materializes them (restricted to `codeBlock`), so the
  existing `create_nodes_from_tree` / `paste_nodes_into_node` commands keep the
  whole paste as one undo step.
- **Editors**: `RichTextEditor` and `TrailingInput` paste handlers now read
  `text/html`, intercept single-line pastes only when they carry markup/URL/
  HTML (plain single lines still use the native paste), and route a typed
  first block (a code block) entirely into following siblings since it can't
  live inside a ProseMirror row.
- **Refactor**: code-language metadata (`CODE_LANGUAGE_OPTIONS`,
  `normalizeCodeLanguage`, `codeLanguageLabel`) moved to a Shiki-free
  `editor/codeLanguages.ts` so the parser (and its bun unit tests) don't pull
  the highlighter engine. `shikiHighlighter` re-exports them for compatibility.

## Design notes

- The decision order is markdown-vs-HTML-vs-flat. Strong markdown signals in
  the plain text (a fence, or a `# ` heading line) win over HTML so pasted
  markdown source isn't mangled by a markdown "shell" wrapped in HTML.
- Headings stay flat (`headingMark` over the whole line), matching the rest of
  the app — we do **not** synthesize a heading hierarchy from `#` levels.
- The parser is single-level for inline marks (no nesting), which matches the
  current renderer behavior and keeps offsets simple.

## Deferred / non-goals

- Internal node-link / `@mention` detection from pasted HTML (nodex has a
  smart-reference path). Out of scope until there's a stable copy format that
  embeds node ids.
- `Cmd+Shift+V` "paste as plain text" toggle. The native paste already covers
  the plain case; revisit if users want to force-flatten rich content.
- Pasted images / files — owned by `asset-subsystem.md`, not this plan.
- Markdown blockquotes as a distinct node type (no such type exists; pasted
  blockquotes become plain rows).

## Tests

- `tests/renderer/pasteParser.test.ts` — inline marks, fenced code, URL
  detection, single-paragraph predicate.
- `tests/core/core.test.ts` — `codeBlock` materialization from a paste tree
  (and that non-`codeBlock` types are ignored).
- `tests/e2e/outliner-paste-format.spec.ts` — inline marks across rows, fenced
  code → code-block row, rich HTML routing, single-line URL wrapping a
  selection (the HTML path only runs in a real browser).
