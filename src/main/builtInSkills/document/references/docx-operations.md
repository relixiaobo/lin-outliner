# DOCX Operations

DOCX files are ZIP packages of WordprocessingML parts, relationships, media,
styles, comments, numbering, footnotes, endnotes, and content types. Treat them
as structured packages, not as single files.

## Inspect First

Use:

```bash
python3 scripts/docx_tool.py inspect input.docx --out report.json
```

Read the report for:

- paragraph and heading counts
- heading level sequence and manual bullet risks
- section, header, footer, footnote, and endnote counts
- table and media counts
- comments and tracked-change counts
- missing comment references
- missing relationship targets
- placeholder-like text
- unusual external relationships

## Editing Rules

- Preserve `word/styles.xml`, numbering, comments, and relationship files unless the edit intentionally changes them.
- Keep runs and paragraph properties intact when making small text changes.
- Do not remove comments, tracked changes, footnotes, endnotes, or hyperlinks unless the user asked.
- Repack the ZIP with the original internal path names.
- Verify by opening, converting, rendering, or inspecting the package when possible.

## DOCX Semantics

- Use real heading styles for headings; do not simulate headings with bold body text.
- Use real numbering definitions for bullets and ordered lists; do not type bullet characters into paragraphs.
- Use explicit table geometry for generated DOCX tables: table width, grid columns, cell widths, cell padding, and no fixed row heights that can clip text.
- Preserve fields, bookmarks, references, headers, footers, notes, comments, and tracked changes unless the requested edit targets them.
- For Google Docs or Word handoff, avoid relying on viewer defaults; explicit page size, margins, styles, and table widths travel better.

## Review and Redline

- Use comments for review notes and tracked changes for proposed edits when the user needs a reviewer workflow.
- Keep every comment tied to a concrete issue or question.
- Summarize unresolved comments and accepted limitations in the delivery report.

## Package Risks

Common failure modes:

- `word/document.xml` missing or malformed
- comments referenced from the document but missing from `word/comments.xml`
- relationship target referenced but absent
- media target copied without a content type
- stale tracked changes left behind
- manually typed bullet characters instead of real numbering
- heading level jumps that make the table of contents unstable
- tables with missing grids or ad-hoc widths
- hidden placeholder text in text boxes, headers, footers, or comments
