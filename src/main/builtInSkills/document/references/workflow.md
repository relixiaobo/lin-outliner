# Document Workflow

## Decision Flow

1. Define the audience, outcome, reader action, and review path.
2. Extract source claims, evidence, required details, constraints, and unknowns.
3. Choose archetype, design preset, and form factors before drafting.
4. Choose the artifact route: Markdown draft, DOCX, PDF handout, comments, redline, or summary.
5. Create a document plan before drafting or editing.
6. Build from the plan.
7. Verify structure, source fidelity, layout semantics, and format-specific risks.
8. Fix concrete issues and recheck.

## Document Plan Schema

When emitting JSON, follow `assets/schemas/document-plan.schema.json`.

Capture:

- `title`: document title
- `audience`: intended readers
- `goal`: communication outcome
- `outputRoute`: Markdown, DOCX, PDF, comments, redline, or summary
- `archetype`: memo, brief, proposal, report, policy, review, playbook, form, or another deliberate shape
- `designPreset`: plain_editorial, business_brief, operator_reference, formal_record, existing_template, or user-provided
- `tone`: concise, formal, legal, executive, technical, persuasive, or another deliberate style
- `sourceMaterials`: inputs used
- `sections`: section objects with `heading`, `purpose`, `formFactor`, `source`, and `notes`
- `verificationPlan`: checks to run before delivery

## Creation Pattern

- Start from the reader's decision or action.
- Put the conclusion before supporting detail unless the genre requires suspense.
- Use section hierarchy to reveal the argument, not just to group paragraphs.
- Choose form factors by reading task: prose for argument, lists for scan, tables for repeated comparable fields, callouts for decisions and caveats.
- Prefer concrete claims backed by source material over broad advice.
- Keep document length proportional to the decision at stake.

## Existing Document Pattern

- Inspect structure, visible text, headings, tables, images, comments, and tracked changes before editing.
- Preserve template style unless the user asks for redesign.
- Separate content edits from formatting fixes.
- Do not silently accept or reject tracked changes.
- Keep comments/redlines intentional and report their final state.
- Do not flatten real Word semantics into plain text: preserve heading styles, numbering, table geometry, fields, comments, notes, and relationships unless the edit requires changing them.

## Delivery Report

When finished, report:

- artifact path
- output route
- source materials used
- verification performed
- known limitations
