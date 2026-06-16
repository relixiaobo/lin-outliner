---
name: document
description: Create, edit, analyze, review, or polish professional documents including Word/DOCX files, Markdown drafts, reports, memos, briefs, proposals, policies, contracts, PDF handouts, comments, redlines, and summaries.
---

# Document

## Overview

Build documents as durable written communication. Treat DOCX, Markdown, PDF, and
plain text as delivery routes selected by audience, review workflow, fidelity,
and layout risk.

## Route

1. Identify the job: create, rewrite, edit, review, redline, comment, inspect,
   summarize, convert, or package for handoff.
2. Extract audience, decision or reader action, source materials, required
   claims, approval constraints, template/style constraints, and review path.
3. Choose an archetype and form-factor plan before drafting. For new documents
   or major rewrites, read `references/document-system.md`.
4. If the user supplied a DOCX, inspect it before editing with
   `python3 ${AGENT_SKILL_DIR}/scripts/docx_tool.py inspect path/to/file.docx --out report.json`
   when useful. Preserve existing template conventions unless the user requests a redesign.
5. Create a document plan before writing. If emitting JSON, keep it compatible
   with `${AGENT_SKILL_DIR}/assets/schemas/document-plan.schema.json`.
6. Choose the output route:
   - Use Markdown for fast drafts, reviewable structure, and agent-friendly iteration.
   - Use DOCX when the user needs Word compatibility, comments, tracked-change workflows, exact table/list behavior, or template preservation.
   - Use PDF only for fixed-layout delivery or handouts after the source document is stable.
7. Build or edit with available local tools. Prefer bundled scripts for
   deterministic structure checks; use richer host rendering/conversion tools
   when available.
8. Verify before delivering. At minimum check source fidelity, heading structure,
   placeholders, local assets, tables, comments/redlines, and render/open limits.

## References

Load only the reference needed for the current route:

- `references/workflow.md` for planning, source mapping, and delivery flow.
- `references/document-system.md` for archetypes, design presets, form factors, tone, hierarchy, and table gates.
- `references/docx-operations.md` for DOCX package inspection, comments, tracked changes, OOXML risks, and template preservation.
- `references/verification.md` for source-fidelity, structural, and format QA.

## Scripts

- `python3 ${AGENT_SKILL_DIR}/scripts/docx_tool.py inspect file.docx --out report.json` inspects DOCX package structure, headings, sections, tables, comments, tracked changes, relationships, media, headers/footers, notes, manual bullets, and placeholder-like text.
- `node ${AGENT_SKILL_DIR}/scripts/markdown_tool.mjs inspect draft.md --out report.json` inspects Markdown/HTML-like drafts for headings, hierarchy jumps, long paragraphs, tables, local asset references, remote dependencies, and placeholder-like text.

The scripts are portable baseline tools. Do not assume product-specific tools
exist. If a host offers richer DOCX rendering, PDF export, visual QA, comments,
or redline tooling, use it and keep the same final verification discipline.

## Quality Bar

- Do not deliver generic prose when the user provided concrete source material.
- Make the document's purpose obvious from the title, opening, and section order.
- Pick document archetype and form factors deliberately; do not use tables as decorative layout boxes.
- Preserve factual source fidelity; label inferences and assumptions.
- Keep headings parallel and useful for skimming.
- Keep Word semantics real: headings are heading styles, lists are numbering definitions, tables have deliberate geometry, comments/redlines are intentional.
- Do not leave placeholders, TODOs, unresolved comments, or accidental tracked changes unless the user asked for them.
- State limitations plainly when rendering, DOCX editing, or visual verification is unavailable.
