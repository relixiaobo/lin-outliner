# Presentation Workflow

## Decision Flow

1. Define the audience and outcome.
2. Extract the core thesis, supporting proof, constraints, data, examples, and must-include assets.
3. Choose the artifact route: PPTX, HTML deck, PDF handout, speaker outline, or cover image.
4. Create a deck plan before building slides.
5. Build from the plan.
6. Verify visually and structurally.
7. Fix concrete issues and recheck.

## Deck Plan Schema

When emitting JSON, follow `assets/schemas/deck-plan.schema.json`.

Capture:

- `title`: deck title
- `audience`: intended audience
- `goal`: communication outcome
- `outputRoute`: PPTX, HTML deck, PDF handout, speaker outline, or cover image
- `visualTemperament`: editorial narrative, grid analytical, or another deliberate direction
- `storySpine`: short sequence of messages the deck must carry
- `slides`: slide objects with `slide`, `purpose`, `headline`, `evidence`, `visual`, and `notes`
- `verificationPlan`: checks to run before delivery

## Creation Pattern

- Start with the story spine: opening promise, problem, insight, proof, implications, action.
- Convert content into slides by purpose, not by paragraph count.
- Keep one primary message per slide.
- Prefer fewer stronger slides over many weak slides.
- Use section dividers when the audience needs a mental reset.

## Existing Deck Pattern

- Inspect slide order, titles, visible text, media, and visual patterns.
- Identify template layouts before editing.
- Map new content to existing layout families.
- Preserve the deck's visual language unless the user asks for redesign.
- Remove unused groups and placeholders.

## Delivery Report

When finished, report:

- artifact path
- output route
- source materials used
- verification performed
- known limitations
