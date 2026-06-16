# Visual Deck System

Use this file for visual decks: HTML decks, designed PPTX files, pitch decks,
conference talks, lecture decks, launch decks, and cover images.

The goal is to reduce design freedom. Pick one direction, one theme, one motif,
and a small set of layout recipes before generating slides.

## Design Directions

Choose exactly one direction unless the user supplies a brand system.

### Editorial Report

Use for thought pieces, founder talks, industry narratives, culture, education,
and decks that need a memorable reading rhythm.

- serif or humanist display headlines
- paper, ink, and one warm accent
- generous whitespace and magazine-like chrome
- half-bleed images, quotes, pull stats, section rhythm
- avoid dense grids and decorative dashboards

### Product Signal

Use for product launches, feature narratives, software demos, roadmaps, and AI
tools.

- clean sans type with high type-scale contrast
- light canvas with one saturated signal color
- screenshots, system diagrams, feature cards, callouts
- sharp frames, minimal shadows, strong alignment
- avoid decorative abstract backgrounds unless they explain the product

### Data Room

Use for strategy, business cases, KPI reviews, market sizing, analysis, and
board-style narratives.

- strict grid, neutral base, one decisive accent
- large numbers, compact captions, clear chart framing
- compare, metric, timeline, and chart recipes
- every number needs a source or note
- avoid tiny tables on projected slides

### Teaching Board

Use for lectures, workshops, internal enablement, frameworks, and method decks.

- calm neutral palette, strong headings, diagram-first pages
- examples, step cards, process flows, before/after pairs
- repeat visual grammar so learners can predict the page
- avoid high decoration that competes with the lesson

## Theme Tokens

Define all color in a small token set before building:

```css
:root {
  --paper: #f7f3ed;
  --surface: #fffdfa;
  --ink: #171717;
  --muted: #635f58;
  --rule: rgba(23, 23, 23, 0.18);
  --accent: #b33951;
  --accent-ink: #ffffff;
}
```

Rules:

- one dominant background, one text color, one muted text color, one accent
- use the accent sparingly: section openers, one metric, one rule, one marker
- do not use multiple unrelated saturated accents
- do not use generic blue by default
- do not use gradients, blobs, bokeh, or decorative orbs as the main design move

## Motif

Pick one repeated motif and carry it across the deck:

- hairline rules and numeric folios
- left-edge signal bars
- boxed evidence frames
- mono labels above headlines
- large background numerals
- diagram nodes with one consistent connector style

Use the motif on most slides. Do not combine all motifs.

## Typography

- headline: a claim, not a topic label
- display headline: 56-88 px in HTML or 40-60 pt in PPTX
- body: readable at presentation distance, usually 20-28 px in HTML or 15-18 pt in PPTX
- captions and labels: no smaller than 14 px in HTML or 10 pt in PPTX
- body text is left aligned; center only covers, section dividers, and short quotes
- keep letter spacing at 0 for normal text

## Composition Rules

- one primary message per slide
- one visual role per slide: image, metric, comparison, diagram, timeline, quote,
  chart, gallery, or typographic statement
- use layout recipes from `layout-recipes.md`; do not improvise the page skeleton
  unless source material forces it
- every 3-5 content slides, insert a reset: section divider, quote, full-bleed
  image, or single metric
- vary recipe families, not styling. A deck can repeat its theme while changing
  cover, split, metric, compare, timeline, gallery, chart, and close pages

## Assets

- prefer real product, place, person, chart, diagram, screenshot, or generated
  bitmap imagery with an explicit communication role
- screenshots need enough space to remain readable
- use contain-fit for UI screenshots and cover-fit for photos
- choose stable image ratios: 21:9, 16:9, 16:10, 4:3, 3:2, 1:1, or 3:4
- do not use stock-like atmospheric images when the audience needs evidence

## Avoid

- plain title plus bullets as the default slide
- accent lines under every title
- mixed palettes with equal visual weight
- small dense tables
- centered body paragraphs
- inconsistent margins
- slide-by-slide styling without a system
- text-only slides unless the slide is a deliberate quote, section, or statement
