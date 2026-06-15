# HTML Decks

Use HTML decks when the user wants a polished, inspectable, browser-presentable
artifact and did not require PowerPoint.

## Requirements

- Produce a self-contained `index.html` unless the user asks for a project folder.
- Use local or inline assets; do not depend on remote CDNs.
- Use responsive 16:9 slides.
- Support keyboard navigation.
- Keep presenter controls outside the visual safe area.
- Respect reduced-motion preferences if animations are present.
- Make print/PDF fallback acceptable.

## Suggested Structure

```html
<main class="deck" data-deck>
  <section class="slide" data-slide="1">...</section>
  <section class="slide" data-slide="2">...</section>
</main>
```

## CSS Rules

- Define a small design token set at `:root`.
- Use stable slide dimensions with `aspect-ratio: 16 / 9`.
- Avoid layout shifts on hover or navigation.
- Do not use decorative gradient blobs or generic bokeh backgrounds.
- Keep text sizes fixed by role, not by viewport width.

## Verification

Run:

```bash
node ${AGENT_SKILL_DIR}/scripts/html_tool.mjs inspect path/to/index.html --out verification.json
```

Then inspect or screenshot the deck in a browser when available.
