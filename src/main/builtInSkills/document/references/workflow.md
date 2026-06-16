# Document Workflow

## Decision Flow

1. Define the audience, outcome, and review path.
2. Extract source claims, evidence, required details, constraints, and unknowns.
3. Choose the artifact route: Markdown draft, DOCX, PDF handout, comments, redline, or summary.
4. Create a document plan before drafting or editing.
5. Build from the plan.
6. Verify structure, source fidelity, and format-specific risks.
7. Fix concrete issues and recheck.

## Document Plan Schema

When emitting JSON, follow `assets/schemas/document-plan.schema.json`.

Capture:

- `title`: document title
- `audience`: intended readers
- `goal`: communication outcome
- `outputRoute`: Markdown, DOCX, PDF, comments, redline, or summary
- `tone`: concise, formal, legal, executive, technical, persuasive, or another deliberate style
- `sourceMaterials`: inputs used
- `sections`: section objects with `heading`, `purpose`, `source`, and `notes`
- `verificationPlan`: checks to run before delivery

## Creation Pattern

- Start from the reader's decision or action.
- Put the conclusion before supporting detail unless the genre requires suspense.
- Use section hierarchy to reveal the argument, not just to group paragraphs.
- Prefer concrete claims backed by source material over broad advice.
- Keep document length proportional to the decision at stake.

## Existing Document Pattern

- Inspect structure, visible text, headings, tables, images, comments, and tracked changes before editing.
- Preserve template style unless the user asks for redesign.
- Separate content edits from formatting fixes.
- Do not silently accept or reject tracked changes.
- Keep comments/redlines intentional and report their final state.

## Delivery Report

When finished, report:

- artifact path
- output route
- source materials used
- verification performed
- known limitations
