---
status: done
priority: P2
owner: relixiaobo
created: 2026-05-25
updated: 2026-05-25
---

# Code Block Editor

Dedicated editor for `codeBlock` nodes. The type and `codeLanguage` field
already exist in `src/core/types.ts` but nothing renders them differently
from a normal text row. nodex ships `editor/CodeBlockEditor.tsx`; lin does
not. This is one of the cleanest unaddressed gaps from the nodex comparison.

Independent of the asset subsystem.

## Shipped (v1)

- `set_code_block` / `set_code_language` core commands (`src/core/core.ts`),
  registered in `commands.ts`, `documentService.ts`, and the renderer
  `api` client. Conversion is guarded to plain content nodes; language is
  normalized (trim + lowercase, empty clears).
- `src/renderer/ui/outliner/CodeBlockRow.tsx`: a transparent `<textarea>`
  layered over a Shiki highlight layer (hidden sizer keeps the height exact
  while highlighting resolves async). Language `<select>` + copy button chrome.
- Keyboard: Enter = code newline with auto-indent; Cmd+Enter exits to a new
  sibling row; Tab / Shift+Tab indent / outdent (2 spaces); Backspace on an
  empty block trashes it; Up/Down at first/last line leave the block; Escape
  exits to selection; Cmd+Z / Cmd+Shift+Z route to app undo/redo.
- `OutlinerItem.tsx` dispatches `CodeBlockRow` for `codeBlock` rows (not
  reference rows); text persists through the existing `apply_node_text_patch`
  flow as plain `RichText`.
- `/code` slash command (in-row + trailing) in `slashCommands.ts`,
  `SlashCommandMenu.tsx`, `trailingTriggers.ts`.
- Long lines scroll horizontally (no wrap): the layers are `white-space: pre`
  and the highlight layer scroll-syncs to the textarea's `scrollLeft/Top`.
- Cross-row block selection across code blocks: selection is the app-managed
  row model (`selectedIds`), so codeBlock rows already participate in pointer
  drag-select and window-level Shift+Arrow. Shift+Arrow inside the block
  extends the textarea's own multi-line selection, but at the first/last line
  it exits into the row selection (`onShiftArrow` → `exitToSelection`), so a
  selection can span the code block and neighbouring ProseMirror rows.
- Shared Shiki module `src/renderer/ui/editor/shikiHighlighter.ts` (JS regex
  engine, single `github-light` theme, default language set + lazy-loaded
  bundled languages). The agent transcript `AgentCodeBlock` was migrated onto
  the same module, so both surfaces share one highlighter (fulfilling the
  original "one toolchain" intent — the agent block previously had no
  highlighting at all).
- Shared, token-compliant CSS: the agent transcript block and the outliner
  code row now use grouped selectors for the container, header, copy button,
  and code text metrics (`--surface-soft` background, `--font-family-mono`,
  `--font-meta`/`--line-meta`, `--space-*` padding). Only the functional
  differences diverge — the agent block is a read-only bounded-height `<pre>`;
  the outliner row is an editable textarea over the highlight layer with a
  language `<select>`.
- Tests: core unit coverage for the new commands; e2e
  (`tests/e2e/outliner-code-block.spec.ts`) for `/code` creation, in-row
  conversion, language picking, multi-line Enter, Cmd+Enter exit, horizontal
  scroll (no wrap), and cross-row block selection via Shift+Arrow.

## Deferred to v2

- Line numbers and folding.
- `/code-ts` / `?lang=ts` slash shortcuts (v1 picks language from the dropdown,
  defaulting to plain text).
- Dark theme (Shiki dual-theme) once the app gains a dark mode. **Will become
  required when dark mode lands** — code blocks are the only surface still
  pinned to `github-light`; ship it in the dark-mode PR.
- Native character-level text selection dragging across the code block /
  ProseMirror boundary. The app has no native cross-row text selection at all
  (cross-row selection is always the block model), so this is out of scope by
  design rather than a code-block-specific gap.

## Goal

- A `codeBlock` row renders as a monospace, syntax-highlighted editor with
  a language picker.
- Soft tab + auto-indent inside the block, but Enter at the end still
  splits like a normal row (creating a sibling), not adds a code newline.
  Use Shift+Enter or Cmd+Enter for in-code newline. To decide.
- The block has a small chrome: language dropdown top-right, "copy" button.

## Non-goals

- A full IDE: no diagnostics, no LSP, no auto-format on save.
- Code execution.
- Diff blocks (separate node type if needed later).

## Design

### Editor pick

Use [Shiki](https://shiki.style/) for highlighting because it's the same
engine the agent's `AgentMarkdown.AgentCodeBlock` already uses
(`src/renderer/ui/agent/AgentMarkdown.tsx`) — keep one toolchain.

For the editor surface itself, a contenteditable with manual indent handling
is enough for v1. ProseMirror is the rich-text editor for normal rows; a
code block is structurally different (no marks, no inline refs, no triggers)
so it does not need to be a ProseMirror node.

Tentative shape:

```tsx
<div className="code-block">
  <div className="code-block-chrome">
    <LanguageSelect value={node.codeLanguage} onChange={setLanguage} />
    <CopyButton text={node.content.text} />
  </div>
  <CodeEditor
    value={node.content.text}
    language={node.codeLanguage}
    onChange={text => run(() => api.applyNodeTextPatch(...))}
  />
</div>
```

Highlighting is rendered as an overlay layer behind the textarea — the
standard "fake textarea + highlight layer" trick — to keep the editing
surface simple.

### Language selection

Persisted as `node.codeLanguage`. Slash command `/code` creates a `codeBlock`
node with optional `?lang=ts` suffix; the language picker can change it
after the fact. Default language: plain text.

### Keyboard semantics

- **Tab inside the block** → insert two spaces (or whatever the configured
  indent is). **Shift+Tab** → outdent the current line.
- **Enter** → newline within the code block. **Backspace at start of empty
  code block** → trash the block and focus previous row (consistent with
  normal row backspace).
- **Cmd+Enter** → exit the code block and create a new normal row after it.
- **Up/Down at edges** → leave block to prev/next row (existing pattern).
- **`/` at start of empty block** → exit and reopen slash menu? Or no —
  treat `/` literally inside a code block. **Decision needed**.

### Outliner integration

Code blocks **don't have children**. If the user tries to Tab-indent a
sibling under a code block, treat the code block like a leaf. Field rows
and references attach to the parent of the code block, not the code block
itself.

Drag-drop, multi-select, batch trash, copy/cut: code blocks participate
like any other row.

### Editing through commands

Reuse the existing `apply_node_text_patch` flow. The code block's text is
just `node.content.text` with empty `marks` and empty `inlineRefs` — no
schema change required for the content.

## Open questions

- Bundle size of Shiki languages: ship a small default set (ts/tsx, js/jsx,
  py, json, md, sh, css, html, sql, go, rust) and lazy-load others on
  demand? Probably yes.
- Should code blocks be foldable / line-numbered? Defer to v2.
- Theme: default to one of Shiki's built-ins; align with lin's dark/light
  mode (probably `github-light` / `github-dark`).
- Selecting text across a code block and a normal row: ProseMirror selection
  doesn't know about non-PM regions. May need a custom selection bridge,
  or accept that cross-boundary text selection doesn't work.

## Implementation sketch

1. New `src/renderer/ui/outliner/CodeBlockRow.tsx`.
2. Wire it into `OutlinerItem.tsx` for `node.type === 'codeBlock'`.
3. Shared Shiki initializer factored out of `AgentMarkdown` so both surfaces
   use the same instance.
4. Slash command entry `/code` (and `/code-ts`, `/code-py` etc. as
   shortcuts) added to `src/renderer/ui/interactions/slashCommands.ts`.
5. Update parity matrix entries for keyboard behavior inside code blocks.

## Test plan

- E2E: `/code ts` creates a code-block row, types `const x = 1`, verifies
  syntax-highlighted output.
- E2E: Enter inside block creates a newline; Cmd+Enter exits to a new row.
- E2E: copy button copies the block's plain text to clipboard.
- E2E: trash + restore preserves text and language.
