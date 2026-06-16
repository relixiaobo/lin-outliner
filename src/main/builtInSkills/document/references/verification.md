# Document Verification

Approach verification as a source-fidelity and format-integrity pass.

## Universal Checks

- source claims are represented faithfully
- title and section order match the requested outcome
- no lorem, TODO, placeholder, sample, dummy, or xxxx text remains
- headings are hierarchical and skimmable
- links and local asset references are not broken
- tables are readable and not needlessly wide
- comments/redlines are intentional and reported
- final artifact opens or renders when local tools allow it

## DOCX Checks

- inspect package structure with `scripts/docx_tool.py`
- check relationship targets and content types
- check comments and tracked changes
- render or convert when possible
- verify headers, footers, footnotes, and endnotes when relevant

## Markdown Checks

- inspect static structure with `scripts/markdown_tool.mjs`
- check heading hierarchy
- check local asset references
- search generated files for placeholders

## Delivery Report

When emitting JSON, follow `assets/schemas/verification-report.schema.json`.

Include:

- `artifact`: final artifact path
- `outputRoute`: artifact route such as Markdown, DOCX, PDF, comments, redline, or summary
- `filesProduced`: produced deliverables
- `sourceMaterials`: source inputs used
- `checks`: check objects with name, status, tool, and evidence or result
- `issues`: issues found, including fixed issues
- `limitations`: checks not possible in the current environment
- `finalStatus`: passed, warning, or failed
