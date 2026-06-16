---
name: document
description: Create, edit, analyze, review, or polish professional documents including Word/DOCX files, Markdown drafts, reports, memos, briefs, proposals, policies, contracts, PDF handouts, comments, redlines, and summaries.
---

# Document

## Overview

Build documents as durable written communication. Treat DOCX, Markdown, PDF, and
plain text as formats selected by audience, review workflow, and delivery needs.

## Route

1. Identify the job: new document, rewrite, edit, review, redline, comment, DOCX inspection, Markdown draft, PDF handout, or executive summary.
2. Extract audience, purpose, required claims, source materials, approval constraints, and style constraints before writing.
3. If the user supplied an existing DOCX, inspect it before editing with `python3 ${AGENT_SKILL_DIR}/scripts/docx_tool.py inspect path/to/file.docx --out report.json` when useful.
4. Create a document plan before writing. If emitting JSON, keep it compatible with `${AGENT_SKILL_DIR}/assets/schemas/document-plan.schema.json`.
5. Choose the output route:
   - Use Markdown for fast drafts, reviewable structure, and agent-friendly iteration.
   - Use DOCX when the user needs Microsoft Word compatibility, comments, tracked-change workflows, or template preservation.
   - Use PDF only for fixed-layout delivery or handouts after the source document is stable.
6. Build or edit with the available local tools. Prefer bundled scripts for deterministic structure checks; use host document render/conversion tools when available.
7. Verify before delivering. At minimum check source fidelity, heading structure, placeholder text, local asset references, comments/redlines state, and render/open limits.

## References

Load only the reference needed for the current route:

- `references/workflow.md` for planning, source mapping, and delivery flow.
- `references/docx-operations.md` for DOCX package inspection, comments, tracked changes, and template risks.
- `references/document-system.md` for structure, tone, hierarchy, and review-ready writing.
- `references/verification.md` for document QA and delivery reporting.

## Scripts

- `python3 ${AGENT_SKILL_DIR}/scripts/docx_tool.py inspect file.docx --out report.json` inspects DOCX package structure, text, headings, comments, tracked changes, relationships, media, and placeholder-like text.
- `node ${AGENT_SKILL_DIR}/scripts/markdown_tool.mjs inspect draft.md --out report.json` inspects Markdown/HTML-like drafts for headings, local asset references, remote dependencies, and placeholder-like text.

The scripts are portable baseline tools. Do not assume product-specific tools exist.
If a host offers richer DOCX rendering, PDF export, or visual QA, use it and keep
the same final verification discipline.

## Quality Bar

- Do not deliver generic prose when the user provided concrete source material.
- Make the document's purpose obvious from the title, opening, and section order.
- Preserve factual source fidelity; label inferences and assumptions.
- Keep headings parallel and useful for skimming.
- Do not leave placeholders, TODOs, unresolved comments, or accidental tracked changes unless the user asked for them.
- State limitations plainly when rendering, DOCX editing, or visual verification is unavailable.
