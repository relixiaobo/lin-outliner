# Layout Recipes

Use registered recipes to keep decks coherent. Each slide plan should name one
recipe in `layout`.

## Recipe Set

| Recipe | Use When | Required Visual Move |
| --- | --- | --- |
| `cover` | opening, title, launch title | large claim, motif, subtitle, context label |
| `hero-media` | cinematic context, customer proof, place/person/product reveal | dominant media with readable text safe area |
| `product-stage` | product launch, feature reveal, screenshot, demo framing | one large product/media object on a clean stage |
| `section` | reset between acts | oversized act title or one statement |
| `split` | explain one idea with proof | one side text, one side image, diagram, or evidence frame |
| `metric` | prove with numbers | 1-3 large numbers with labels and source note |
| `compare` | before/after, options, tradeoffs | two or three aligned columns with shared scale |
| `timeline` | sequence, roadmap, process | horizontal or vertical steps with dates or stages |
| `diagram` | system, workflow, relationship | nodes, arrows, or spatial model with labels outside geometry |
| `chart` | quantitative evidence | one chart, one headline, clear annotation |
| `feature-grid` | 3-6 capabilities, pillars, benefits, modules | compact grid with consistent icon/label/spec rhythm |
| `gallery` | examples, screenshots, evidence wall | image grid with consistent ratios and captions |
| `quote` | memorable voice or turning point | large quote, source, minimal support text |
| `close` | final takeaway or action | one final claim plus 1-3 next actions |

## Deck Rhythm

- 6-8 slides: use at least 4 different recipes
- 9-14 slides: use at least 5 different recipes
- 15+ slides: use at least 6 different recipes and section resets
- no more than 2 consecutive slides should use the same recipe
- no more than 3 slides in a row should be mostly text

## Recipe Notes

### cover

- no bullet list
- use a large claim, subtitle, date/context, and one motif
- make the first viewport feel designed even without images

### hero-media

- let the media carry the slide; support copy stays short
- keep text in a safe area with strong contrast
- crop intentionally and avoid dark blurred atmospheric filler

### product-stage

- one object is the hero: product screenshot, device mock, UI panel, artifact, or diagram
- do not surround the object with many small cards
- pair it with a single claim and 2-4 spec labels or proof points

### split

- choose a 45/55 or 55/45 balance
- give the visual side a real role: screenshot, diagram, image, or evidence
- do not put a card inside another card

### metric

- make the number the first thing the audience sees
- include unit and source/note
- use one accent metric only when several metrics appear

### compare

- align columns to the same baseline
- use the same row structure on both sides
- avoid pros/cons walls; make the contrast visible

### timeline

- keep labels short
- show sequence with spacing, not paragraphs
- split into multiple slides when steps become dense

### diagram

- text labels stay in HTML/text boxes, not inside SVG paths when avoidable
- geometry should explain relationships, not decorate
- use one connector style

### feature-grid

- each cell needs the same content structure
- keep labels short and action-oriented
- use icons, numbers, or spec labels only when they clarify the feature set
- avoid equal-weight paragraphs in every cell

### gallery

- use consistent image ratios
- captions explain why each example matters
- screenshots use contain-fit when text readability matters

### quote

- quote text is the visual object
- keep source legible but secondary
- use sparingly for rhythm, not as filler
