---
name: presentation
description: Create, edit, analyze, or improve slide decks, presentations, PPT/PowerPoint or .pptx files, HTML decks, pitch decks, talks, lecture decks, PDF handouts, speaker outlines, and deck cover images.
---

# Presentation

## Overview

Build presentation artifacts as communication products, not as file-format chores.
Treat PPTX, HTML, PDF, and images as output formats selected by the user's goal.

## Route

1. Identify the job: new deck, existing deck analysis, existing deck edit, HTML deck, PPTX output, PDF handout, speaker outline, or cover image.
2. If the user supplied source material, read it first and extract thesis, audience, proof, data, constraints, and must-include details before planning slides.
3. If the user supplied an existing deck or template, inspect content and visual structure before editing. For PPTX files, use `python3 ${AGENT_SKILL_DIR}/scripts/pptx_tool.py inspect path/to/deck.pptx --out report.json` when useful.
4. Choose one visual system before building: design direction, theme, motif,
   typography posture, and layout recipe set. Use
   `references/visual-deck-system.md` and `references/layout-recipes.md` for
   visual decks. If the user asks for modern, premium, launch, keynote, or less
   old-fashioned templates, choose the `Keynote Stage` direction unless the
   content clearly needs another system.
5. Create a deck plan before building. Include slide number, purpose, headline,
   evidence/source, layout recipe, visual treatment, and output notes. If
   emitting JSON, keep it compatible with
   `${AGENT_SKILL_DIR}/assets/schemas/deck-plan.schema.json`. See
   `references/workflow.md`.
6. Choose the output route:
   - Use PPTX when the user explicitly asks for PowerPoint, provides a PPTX template, or needs a file for PowerPoint/Keynote workflows.
   - Use a self-contained HTML deck when the user wants a polished, inspectable, browser-presentable artifact and did not require PPTX.
   - Use PDF or cover images only when the user asks for a handout, preview, share card, or static export.
7. Build the artifact with the available local tools. Prefer bundled scripts for deterministic checks, and use equivalent host tools only when they preserve the same verification contract.
8. Verify before delivering. At minimum search for placeholders, check source fidelity, inspect visual layout, and report what was verified. If emitting JSON, keep it compatible with `${AGENT_SKILL_DIR}/assets/schemas/verification-report.schema.json`.

## References

Load only the reference needed for the current route:

- `references/workflow.md` for deck planning, content mapping, and delivery flow.
- `references/pptx-operations.md` for PPTX/template inspection, OOXML package risks, and PowerPoint QA.
- `references/visual-deck-system.md` for design directions, themes, motifs, typography, and composition rules.
- `references/layout-recipes.md` for registered slide recipes and when to use each one.
- `references/html-deck.md` for self-contained HTML deck structure, template usage, and interaction rules.
- `references/verification.md` for placeholder, rendering, overflow, asset, and source-fidelity checks.

## Scripts

- `python3 ${AGENT_SKILL_DIR}/scripts/pptx_tool.py inspect deck.pptx --out report.json` inspects PPTX package structure, slide order, relationships, media, notes, and likely placeholders.
- `node ${AGENT_SKILL_DIR}/scripts/html_tool.mjs inspect deck.html --out report.json` inspects static HTML decks for slides, broken local asset references, placeholder text, and basic structure.

The scripts are portable baseline tools. Do not assume product-specific tools exist.
If a host offers equivalent conversion, rendering, or browser automation, it may be
used, but the final artifact still needs the same verification report.

## Quality Bar

- Do not deliver a title-plus-bullets dump unless the user asked for a plain outline.
- Every normal slide needs a clear job: orient, explain, prove, compare, transition, or close.
- Every visual slide needs an intentional visual element: image, chart, diagram, icon system, typographic composition, data block, or structured layout.
- Do not invent a new layout for every slide. Choose from the registered recipes, then adapt content inside the recipe.
- Preserve templates by removing unused placeholder groups, not just clearing text.
- Run at least one fix-and-recheck pass after creating or editing a visual deck.
- State limitations plainly when rendering or conversion is unavailable.
