# Presentation Workflow

## Decision Flow

1. Define the audience and outcome.
2. Extract the core thesis, supporting proof, constraints, data, examples, and must-include assets.
3. Choose the artifact route: PPTX, HTML deck, PDF handout, speaker outline, or cover image.
4. Choose the visual system: design direction, theme tokens, motif, and layout recipe set.
5. Create a deck plan before building slides.
6. Build from the plan.
7. Verify visually and structurally.
8. Fix concrete issues and recheck.

## Deck Plan Schema

When emitting JSON, follow `assets/schemas/deck-plan.schema.json`.

Capture:

- `title`: deck title
- `audience`: intended audience
- `goal`: communication outcome
- `outputRoute`: PPTX, HTML deck, PDF handout, speaker outline, or cover image
- `visualTemperament`: editorial narrative, grid analytical, or another deliberate direction
- `visualSystem`: design direction, style pack, theme, motif, and typography posture
- `storySpine`: short sequence of messages the deck must carry
- `slides`: slide objects with `slide`, `purpose`, `headline`, `evidence`, `layout`, `visual`, and `notes`
- `verificationPlan`: checks to run before delivery

## Creation Pattern

- Start with the story spine: opening promise, problem, insight, proof, implications, action.
- Convert content into slides by purpose, not by paragraph count.
- Keep one primary message per slide.
- Prefer fewer stronger slides over many weak slides.
- Use section dividers when the audience needs a mental reset.
- Assign a registered layout recipe to every slide before writing slide code.
- Use the chosen motif on most slides so the deck reads as one system.
- For modern keynote-style decks, start from a stage/product/media recipe and
  keep the page sparse; avoid report cards and decorative business templates.

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
