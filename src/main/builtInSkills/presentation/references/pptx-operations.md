# PPTX Operations

PPTX files are ZIP packages of XML parts, relationships, media, charts, notes,
layouts, masters, and content types. Treat them as structured packages, not as
single files.

## Inspect First

Use:

```bash
python3 scripts/pptx_tool.py inspect input.pptx --out report.json
```

Read the report for:

- slide count and slide order
- missing relationship targets
- media/chart/notes references
- slide layouts and masters
- placeholder-like text
- hidden or unusual package parts

## Template Editing

When using an existing deck as a template:

1. Render or inspect thumbnails if possible.
2. Identify layout families: cover, section, image-led, comparison, process, stat, quote, chart, closing.
3. Map new content to existing layouts.
4. Duplicate or remove whole slide/group structures deliberately.
5. Replace content after structural edits.
6. Clean unused placeholders and orphaned assets.
7. Repack and verify.

## Package Risks

Common failure modes:

- slide exists but is not in `ppt/presentation.xml`
- slide relationship missing from `ppt/_rels/presentation.xml.rels`
- media/chart target referenced but absent
- `[Content_Types].xml` missing an override
- notes or comments copied with stale relationships
- placeholder text left in hidden groups
- text overflow visible only after rendering

## Generation Notes

If generating PPTX with a library:

- set slide size explicitly
- use real list paragraphs, not pasted bullet characters
- keep images in stable aspect-ratio boxes
- do not rely on default theme colors
- verify by opening, converting, or rendering when possible

If reliable PPTX generation is not available, produce an HTML deck or slide plan
and state the conversion gap clearly.
